import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { abrirEnvelope } from '../../src/infrastructure/adapters/mni/mni.mapper.js';
import { MniAdapter } from '../../src/infrastructure/adapters/mni/MniAdapter.js';

/**
 * A sonda é um script `.mjs` (como as outras), então entra por import dinâmico de
 * um caminho em variável: o TypeScript não tenta tipá-lo.
 *
 * Fixtures SINTÉTICAS, sempre. A forma do aviso segue o WSDL do TJGO lido pelo
 * dono: `tipoAvisoComunicacaoPendente` = `destinatario`, `processo`,
 * `dataDisponibilizacao` + atributos `idAviso` e `tipoComunicacao`; SEM prazo e
 * SEM data limite. A resposta real ainda não foi capturada (é para isso que a
 * sonda existe), então nenhum teste aqui "prova" o que o tribunal devolve.
 */
interface Aviso {
  indice: number;
  campos: { nome: string; formato: string; papel: string }[];
  tipoComunicacao: string | null;
  datas: { papel: string; nome: string; formato: string; valor: string | null }[];
}
interface Tabela {
  versao: string;
  chaveDaLista: string | null;
  acompanhados: {
    avisosComProcesso: number;
    acompanhados: number;
    totalCarteira: number;
  } | null;
  avisos: Aviso[];
}
interface Resumo {
  total: number;
  tipos: Record<string, number>;
  limite: { campoExiste: boolean; campos: string[]; preenchidos: number };
  publicacao: { comData: number; formatos: string[] };
  acompanhados: Tabela['acompanhados'];
}
interface Analise {
  chaveDaLista: string | null;
  avisos: Aviso[];
  numerosPorAviso: string[][];
}
interface Deps {
  tmpdir: () => string;
  lerArquivo: (c: string) => string;
  gravarArquivo: (c: string, t: string) => void;
  carregarContexto: (a: unknown) => Promise<unknown>;
  baixarDocumento: (u: string) => Promise<string>;
  consultarAvisos: (a: unknown) => Promise<unknown>;
}
interface No {
  nome: string;
  tipo: string;
  minOccurs: string;
  maxOccurs: string;
  filhos: No[];
}
interface Op {
  encontrada: boolean;
  documentacao?: string;
  soapAction?: string;
  entrada: { elemento: string; namespace?: string; filhos: No[] };
  saida: { elemento: string; filhos: No[] };
}
interface WsdlAnalise {
  operacoesDoServico: string[];
  proibidasPresentes: string[];
  operacoes: Record<string, Op>;
}
interface Sonda {
  VERSAO_SONDA: string;
  OPERACAO: string;
  ACAO_AVISOS: string;
  OPERACOES_PROIBIDAS: readonly string[];
  ORDEM_DA_ENTRADA: readonly string[];
  SondaAbortada: new (m: string) => Error;
  garantirOperacaoPermitida(o: string): void;
  validarEnvelopeEAcao(xml: string, acao: string): void;
  envelopeAvisosPendentes(
    c: { identificacao: string; senha: string },
    p?: { prefixoServico?: string; prefixoTipos?: string },
  ): string;
  envelopeParaExibir(): string;
  mascararNumeroProcesso(t: string): string;
  lerData(v: string): { formato: string; iso: string } | undefined;
  formatoDe(v: string): string;
  analisarResposta(conteudo: unknown): Analise;
  montarTabela(a: unknown): Tabela;
  validarTabela(b: unknown): Tabela;
  resumir(t: Tabela, o?: { esperado?: number }): Resumo;
  julgar(r: Resumo): { rotulo: string; motivo: string };
  contarAcompanhados(n: string[][], c: Set<string>): NonNullable<Tabela['acompanhados']>;
  linhasDeConferencia(a: Analise, o: { mostrar: boolean }): string[];
  lerArgumentos(a: string[]): Record<string, string | boolean>;
  analisarWsdl(d: Map<string, string>): WsdlAnalise;
  avaliarWsdl(a: WsdlAnalise): { abortar: string[]; avisos: string[]; acao: string };
  baixarWsdlCompleto(
    b: (u: string) => Promise<string>,
    u: string,
  ): Promise<Map<string, string>>;
  indiciosDeEfeitoColateral(d: string): { fortes: string[]; fracos: string[] };
  principal(argv: string[], deps: Deps, escrever: (l: string) => void): Promise<number>;
}

const CAMINHO = resolve(__dirname, '../../scripts/sonda-avisos-pendentes.mjs');
const carregar = async (): Promise<Sonda> =>
  (await import(/* @vite-ignore */ CAMINHO)) as unknown as Sonda;

const NS_SERVICO = 'http://www.cnj.jus.br/servico-intercomunicacao-2.2.2/';
const NS_TIPOS = 'http://www.cnj.jus.br/tipos-servico-intercomunicacao-2.2.2';
const NS_INTER = 'http://www.cnj.jus.br/intercomunicacao-2.2.2';

// --- fixtures sintéticas de RESPOSTA ----------------------------------------------
/** Número CNJ com DV correto (mesma conta do teste de NumeroCNJ). */
function numeroValido(
  seq: string,
  ano = '2024',
  j = '8',
  tr = '09',
  origem = '0100',
): string {
  const base = BigInt(`${seq}${ano}${j}${tr}${origem}00`);
  const dv = String(98n - (base % 97n)).padStart(2, '0');
  return `${seq}-${dv}.${ano}.${j}.${tr}.${origem}`;
}
const NUMEROS = Array.from({ length: 10 }, (_, i) => numeroValido(String(1000001 + i)));

/** Como os prefixos aparecem: declarados no topo, ou o namespace inline (padrão). */
type Estilo = 'ns-numerados' | 'prefixos-outros' | 'padrao-inline';

interface OpcoesAviso {
  tipo?: string | null;
  disponibilizacao?: string | null;
  formato?: 'ts' | 'iso' | 'br';
  /** Cenário INESPERADO pelo WSDL: o tribunal manda um campo de data limite. */
  comLimite?: boolean;
}

const data = (d: string, formato: 'ts' | 'iso' | 'br'): string =>
  formato === 'ts'
    ? `${d.replaceAll('-', '')}093000`
    : formato === 'iso'
      ? `${d}T09:30:00`
      : d.split('-').reverse().join('/');

/** Gera um elemento no namespace dado, no estilo escolhido. */
function elemento(
  estilo: Estilo,
  prefixos: { corpo: string; inter: string },
  ns: 'corpo' | 'inter',
  nome: string,
  atributos: string,
  interior: string,
): string {
  const abre = `${atributos ? ' ' + atributos : ''}`;
  if (estilo === 'padrao-inline') {
    const url = ns === 'corpo' ? NS_TIPOS : NS_INTER;
    const fim = interior === '' ? '/>' : `>${interior}</${nome}>`;
    return `<${nome} xmlns="${url}"${abre}${fim}`;
  }
  const p = ns === 'corpo' ? prefixos.corpo : prefixos.inter;
  return interior === ''
    ? `<${p}:${nome}${abre}/>`
    : `<${p}:${nome}${abre}>${interior}</${p}:${nome}>`;
}

function aviso(i: number, o: OpcoesAviso = {}, estilo: Estilo = 'ns-numerados'): string {
  const prefixos =
    estilo === 'prefixos-outros'
      ? { corpo: 'tp', inter: 'ic' }
      : { corpo: 'ns2', inter: 'ns3' };
  const tipo = o.tipo === undefined ? 'Intimação' : o.tipo;
  const formato = o.formato ?? 'ts';
  const disp =
    o.disponibilizacao === undefined ? `2026-10-0${1 + (i % 5)}` : o.disponibilizacao;
  const e = (
    ns: 'corpo' | 'inter',
    nome: string,
    attr: string,
    interior: string,
  ): string => elemento(estilo, prefixos, ns, nome, attr, interior);
  const filhos =
    e('inter', 'destinatario', '', 'Fulano Sintetico de Tal') +
    e('inter', 'processo', `numero="${NUMEROS[i]}" classeProcessual="7"`, '') +
    (disp === null ? '' : e('inter', 'dataDisponibilizacao', '', data(disp, formato))) +
    (o.comLimite
      ? e('inter', 'dataLimite', '', data(`2026-10-${20 + (i % 5)}`, formato))
      : '');
  const attrs =
    `idAviso="${9000 + i}"` + (tipo === null ? '' : ` tipoComunicacao="${tipo}"`);
  return e('corpo', 'aviso', attrs, filhos);
}

function resposta(avisos: string[], estilo: Estilo = 'ns-numerados', extra = ''): string {
  const decl =
    estilo === 'padrao-inline'
      ? `xmlns="${NS_SERVICO}"`
      : estilo === 'prefixos-outros'
        ? `xmlns:sv="${NS_SERVICO}" xmlns:tp="${NS_TIPOS}" xmlns:ic="${NS_INTER}"`
        : `xmlns:ns2="${NS_TIPOS}" xmlns:ns3="${NS_INTER}" xmlns:ns5="${NS_SERVICO}"`;
  const raiz =
    estilo === 'padrao-inline'
      ? 'consultarAvisosPendentesResposta'
      : estilo === 'prefixos-outros'
        ? 'sv:consultarAvisosPendentesResposta'
        : 'ns5:consultarAvisosPendentesResposta';
  const p =
    estilo === 'prefixos-outros' ? 'tp:' : estilo === 'padrao-inline' ? '' : 'ns2:';
  const x = estilo === 'padrao-inline' ? ` xmlns="${NS_TIPOS}"` : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${raiz} ${decl}><${p}sucesso${x}>true</${p}sucesso>${extra}${avisos.join('')}` +
    `</${raiz}></soap:Body></soap:Envelope>`
  );
}
const conteudoDe = (xml: string): unknown => abrirEnvelope(xml).conteudo;

/** Dez avisos como o WSDL prevê: tipo e disponibilização, nada de prazo. */
function dezAvisos(estilo: Estilo = 'ns-numerados'): string[] {
  return NUMEROS.map((_, i) =>
    aviso(i, { tipo: i % 3 === 0 ? 'Citação' : 'Intimação' }, estilo),
  );
}

// --- fixtures sintéticas de WSDL (em DOIS arquivos, como o CXF faz) -----------------
const WSDL_PRINCIPAL = (doc = ''): string => `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:xs="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="${NS_SERVICO}" targetNamespace="${NS_SERVICO}">
 <wsdl:types><xs:schema targetNamespace="${NS_SERVICO}">
   <xs:import namespace="${NS_TIPOS}" schemaLocation="https://tribunal.exemplo/Svc?xsd=1"/>
 </xs:schema></wsdl:types>
 <wsdl:message name="avisosIn"><wsdl:part name="p" element="tns:consultarAvisosPendentes"/></wsdl:message>
 <wsdl:message name="avisosOut"><wsdl:part name="p" element="tns:consultarAvisosPendentesResposta"/></wsdl:message>
 <wsdl:message name="relIn"><wsdl:part name="p" element="tns:consultarRelatorioDeIntimacoesTJGO"/></wsdl:message>
 <wsdl:message name="relOut"><wsdl:part name="p" element="tns:consultarRelatorioDeIntimacoesTJGOResposta"/></wsdl:message>
 <wsdl:message name="confIn"><wsdl:part name="p" element="tns:confirmarRecebimento"/></wsdl:message>
 <wsdl:message name="confOut"><wsdl:part name="p" element="tns:confirmarRecebimentoResposta"/></wsdl:message>
 <wsdl:portType name="Svc">
  <wsdl:operation name="consultarAvisosPendentes">
   ${doc ? `<wsdl:documentation>${doc}</wsdl:documentation>` : ''}
   <wsdl:input message="tns:avisosIn"/><wsdl:output message="tns:avisosOut"/>
  </wsdl:operation>
  <wsdl:operation name="consultarRelatorioDeIntimacoesTJGO"><wsdl:input message="tns:relIn"/><wsdl:output message="tns:relOut"/></wsdl:operation>
  <wsdl:operation name="confirmarRecebimento"><wsdl:input message="tns:confIn"/><wsdl:output message="tns:confOut"/></wsdl:operation>
 </wsdl:portType>
 <wsdl:binding name="B" type="tns:Svc">
  <wsdl:operation name="consultarAvisosPendentes"><soap:operation soapAction="${NS_SERVICO}consultarAvisosPendentes"/></wsdl:operation>
 </wsdl:binding>
</wsdl:definitions>`;

const XSD = (
  opcoes: { ordem?: 'ok' | 'trocada'; obrigatorioExtra?: boolean } = {},
): string => {
  const { ordem = 'ok', obrigatorioExtra = false } = opcoes;
  const id = '<xs:element name="idConsultante" type="xs:string" minOccurs="0"/>';
  const senha = '<xs:element name="senhaConsultante" type="xs:string" minOccurs="0"/>';
  return `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="${NS_SERVICO}" xmlns:ic="${NS_INTER}" targetNamespace="${NS_SERVICO}">
 <xs:element name="consultarAvisosPendentes"><xs:complexType><xs:sequence>
   <xs:element name="idRepresentado" type="xs:string" minOccurs="0" maxOccurs="unbounded"/>
   ${ordem === 'ok' ? id + senha : senha + id}
   <xs:element name="dataReferencia" type="xs:string" minOccurs="0"/>
   ${obrigatorioExtra ? '<xs:element name="codigoNovo" type="xs:string"/>' : ''}
 </xs:sequence></xs:complexType></xs:element>
 <xs:element name="consultarAvisosPendentesResposta"><xs:complexType><xs:sequence>
   <xs:element name="sucesso" type="xs:boolean"/>
   <xs:element name="mensagem" type="xs:string" minOccurs="0"/>
   <xs:element name="aviso" type="tns:tipoAvisoComunicacaoPendente" minOccurs="0" maxOccurs="unbounded"/>
 </xs:sequence></xs:complexType></xs:element>
 <xs:complexType name="tipoAvisoComunicacaoPendente"><xs:sequence>
   <xs:element name="destinatario" type="xs:string" minOccurs="0"/>
   <xs:element name="processo" type="xs:string"/>
   <xs:element name="dataDisponibilizacao" type="xs:string"/>
 </xs:sequence>
   <xs:attribute name="idAviso" type="xs:string"/><xs:attribute name="tipoComunicacao" type="xs:string"/>
 </xs:complexType>
 <xs:element name="consultarRelatorioDeIntimacoesTJGO"><xs:complexType><xs:sequence>
   <xs:element name="requisicaoCredenciaisTJGO" type="tns:requisicaoCredenciaisTJGO" minOccurs="0"/>
 </xs:sequence></xs:complexType></xs:element>
 <xs:complexType name="requisicaoCredenciaisTJGO"><xs:sequence>
   <xs:element name="grupoCodigo" type="xs:string" minOccurs="0"/>
   <xs:element name="id_UsuarioServentiaChefe" type="xs:string" minOccurs="0"/>
   <xs:element name="id_serventiaCargo" type="xs:string" minOccurs="0"/>
   <xs:element name="id_serventiaCargoUsuarioChefe" type="xs:string" minOccurs="0"/>
   <xs:element name="id_usuarioServentia" type="xs:string" minOccurs="0"/>
   <xs:element name="loginConsultante" type="xs:string" minOccurs="0"/>
   <xs:element name="senhaConsultante" type="xs:string" minOccurs="0"/>
 </xs:sequence></xs:complexType>
 <xs:element name="consultarRelatorioDeIntimacoesTJGOResposta"><xs:complexType><xs:sequence>
   <xs:element name="conteudoArquivo" type="xs:base64Binary" minOccurs="0"/>
   <xs:element name="nomeArquivo" type="xs:string" minOccurs="0"/>
   <xs:element name="quantidadeDeRegistros" type="xs:int" minOccurs="0"/>
 </xs:sequence></xs:complexType></xs:element>
 <xs:element name="confirmarRecebimento"><xs:complexType><xs:sequence><xs:element name="x" type="xs:string"/></xs:sequence></xs:complexType></xs:element>
 <xs:element name="confirmarRecebimentoResposta"><xs:complexType><xs:sequence><xs:element name="sucesso" type="xs:boolean"/></xs:sequence></xs:complexType></xs:element>
</xs:schema>`;
};
const juntos = (w = WSDL_PRINCIPAL(), x = XSD()): Map<string, string> =>
  new Map([
    ['wsdl', w],
    ['xsd', x],
  ]);

const pastas: string[] = [];
const novaPasta = (): string => {
  const p = mkdtempSync(join(tmpdir(), 'sonda-avisos-spec-'));
  pastas.push(p);
  return p;
};
afterEach(() => {
  while (pastas.length) rmSync(pastas.pop() as string, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------------
describe('sonda-avisos-pendentes · segurança das operações', () => {
  it('recusa por construção as três operações que podem contar como ciência', async () => {
    const s = await carregar();
    expect([...s.OPERACOES_PROIBIDAS].sort()).toEqual(
      [
        'confirmarRecebimento',
        'consultarTeorComunicacao',
        'entregarManifestacaoProcessual',
      ].sort(),
    );
    for (const op of s.OPERACOES_PROIBIDAS) {
      expect(() => s.garantirOperacaoPermitida(op)).toThrow(/ciência|prazo/i);
      expect(() => s.garantirOperacaoPermitida(op.toUpperCase())).toThrow();
      expect(() => s.garantirOperacaoPermitida(`http://x/servico/${op}`)).toThrow();
    }
  });

  it('só deixa passar consultarAvisosPendentes — nem o relatório local do TJGO', async () => {
    const s = await carregar();
    expect(() => s.garantirOperacaoPermitida('consultarAvisosPendentes')).not.toThrow();
    expect(() => s.garantirOperacaoPermitida(s.ACAO_AVISOS)).not.toThrow();
    for (const outra of [
      'consultarRelatorioDeIntimacoesTJGO',
      'consultarProcesso',
      'consultarAlteracao',
      '',
      'consultarAvisosPendentesX',
    ]) {
      expect(() => s.garantirOperacaoPermitida(outra)).toThrow();
    }
  });

  it('o envelope manda só idConsultante e senhaConsultante, na ordem do WSDL, sem dataReferencia', async () => {
    const s = await carregar();
    const xml = s.envelopeAvisosPendentes({ identificacao: 'adv', senha: 'a&b<c' });
    expect(() => s.validarEnvelopeEAcao(xml, s.ACAO_AVISOS)).not.toThrow();
    expect(xml).toContain('<srv:consultarAvisosPendentes>');
    expect(xml).toContain('a&amp;b&lt;c'); // senha com & e < não quebra o XML
    expect(xml).not.toMatch(/idRepresentado|dataReferencia/);

    // Os elementos enviados são uma subsequência da ordem do xs:sequence do WSDL.
    const enviados = [...xml.matchAll(/<tip:(\w+)>/g)].map((m) => m[1] as string);
    expect(enviados).toEqual(['idConsultante', 'senhaConsultante']);
    const ordem = [...s.ORDEM_DA_ENTRADA];
    expect(ordem).toEqual([
      'idRepresentado',
      'idConsultante',
      'senhaConsultante',
      'dataReferencia',
    ]);
    expect(enviados.map((n) => ordem.indexOf(n))).toEqual([1, 2]);
  });

  it('o corpo está no namespace do serviço e os filhos no de tipos (resolvidos, não só nomeados)', async () => {
    const s = await carregar();
    const xml = s.envelopeAvisosPendentes({ identificacao: 'adv', senha: 'x' });
    expect(xml).toContain(`xmlns:srv="${NS_SERVICO}"`);
    expect(xml).toContain(`xmlns:tip="${NS_TIPOS}"`);
  });

  it('aceita prefixos diferentes e recusa namespace trocado, mesmo com o prefixo "certo"', async () => {
    const s = await carregar();
    const outro = s.envelopeAvisosPendentes(
      { identificacao: 'adv', senha: 'x' },
      { prefixoServico: 'svc', prefixoTipos: 't.ipos-2' },
    );
    expect(() => s.validarEnvelopeEAcao(outro, s.ACAO_AVISOS)).not.toThrow();

    const bom = s.envelopeAvisosPendentes({ identificacao: 'adv', senha: 'x' });
    // prefixo "srv" apontando para o namespace de TIPOS: o nome parece certo, o sentido não
    const servicoTrocado = bom.replace(
      `xmlns:srv="${NS_SERVICO}"`,
      `xmlns:srv="${NS_TIPOS}"`,
    );
    expect(() => s.validarEnvelopeEAcao(servicoTrocado, s.ACAO_AVISOS)).toThrow(
      /namespace do serviço/,
    );
    const tiposTrocado = bom.replace(
      `xmlns:tip="${NS_TIPOS}"`,
      `xmlns:tip="${NS_INTER}"`,
    );
    expect(() => s.validarEnvelopeEAcao(tiposTrocado, s.ACAO_AVISOS)).toThrow(
      /namespace de tipos/,
    );
  });

  it('recusa elemento além do plano (dataReferencia, idRepresentado) e ordem trocada', async () => {
    const s = await carregar();
    const bom = s.envelopeAvisosPendentes({ identificacao: 'adv', senha: 'x' });
    const comData = bom.replace(
      '</srv:',
      '<tip:dataReferencia>20260101</tip:dataReferencia></srv:',
    );
    expect(() => s.validarEnvelopeEAcao(comData, s.ACAO_AVISOS)).toThrow(
      /dataReferencia/,
    );
    const comRep = bom.replace(
      '<tip:idConsultante>',
      '<tip:idRepresentado>1</tip:idRepresentado><tip:idConsultante>',
    );
    expect(() => s.validarEnvelopeEAcao(comRep, s.ACAO_AVISOS)).toThrow(/idRepresentado/);
    const trocado = bom
      .replace('<tip:idConsultante>adv</tip:idConsultante>', '@@')
      .replace(
        '<tip:senhaConsultante>x</tip:senhaConsultante>',
        '<tip:senhaConsultante>x</tip:senhaConsultante><tip:idConsultante>adv</tip:idConsultante>',
      )
      .replace('@@', '');
    expect(() => s.validarEnvelopeEAcao(trocado, s.ACAO_AVISOS)).toThrow(/ordem/);
  });

  it('recusa envelope de outra operação, SOAPAction trocado e nome proibido escondido no corpo', async () => {
    const s = await carregar();
    const bom = s.envelopeAvisosPendentes({ identificacao: 'adv', senha: 'x' });
    const outra = bom.replaceAll('consultarAvisosPendentes', 'confirmarRecebimento');
    expect(() => s.validarEnvelopeEAcao(outra, s.ACAO_AVISOS)).toThrow();
    expect(() =>
      s.validarEnvelopeEAcao(
        bom,
        s.ACAO_AVISOS.replace('consultarAvisosPendentes', 'consultarTeorComunicacao'),
      ),
    ).toThrow();
    const escondido = bom.replace(
      '</srv:',
      '<tip:x>entregarManifestacaoProcessual</tip:x></srv:',
    );
    expect(() => s.validarEnvelopeEAcao(escondido, s.ACAO_AVISOS)).toThrow(
      /dentro do envelope/,
    );
  });

  it('o envelope exibido no --seco nunca leva identificação nem senha', async () => {
    const s = await carregar();
    const xml = s.envelopeParaExibir();
    expect(xml).toContain('(omitido)');
    expect(() => s.validarEnvelopeEAcao(xml, s.ACAO_AVISOS)).not.toThrow();
  });

  it('depende de MniAdapter.chamar, a rota única do adapter até o tribunal', () => {
    const proto = MniAdapter.prototype as unknown as Record<string, unknown>;
    expect(typeof proto['chamar']).toBe('function');
    expect((proto['chamar'] as (...a: unknown[]) => unknown).length).toBe(3);
    const fonte = readFileSync(CAMINHO, 'utf8');
    expect(fonte).not.toMatch(/TokenBucketRateLimiter/);
    expect(fonte).toMatch(/adapter\['chamar'\]/);
  });
});

describe('sonda-avisos-pendentes · mascaramento', () => {
  it('mostra só tribunal (J.TR) e apaga o resto do número', async () => {
    const s = await carregar();
    expect(s.mascararNumeroProcesso('1000001-97.2024.8.09.0100')).toBe(
      '*******-**.****.8.09.****',
    );
    const soDigitos = (NUMEROS[0] as string).replace(/\D/g, '');
    expect(s.mascararNumeroProcesso(soDigitos)).toBe('*******-**.****.8.09.****');
    expect(s.mascararNumeroProcesso('abc-123')).toBe('***-***');
  });

  it('sem --mostrar a conferência não traz número nem data; com --mostrar traz ambos', async () => {
    const s = await carregar();
    const analise = s.analisarResposta(conteudoDe(resposta(dezAvisos())));
    const mascarado = s.linhasDeConferencia(analise, { mostrar: false }).join('\n');
    for (const n of NUMEROS) expect(mascarado).not.toContain(n);
    expect(mascarado).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(mascarado).toContain('*******-**.****.8.09.****');
    expect(mascarado).toContain('tipo Citação');
    expect(mascarado).not.toMatch(/data limite/); // o aviso não tem esse campo

    const aberto = s.linhasDeConferencia(analise, { mostrar: true });
    expect(aberto[0]).toContain(NUMEROS[0]);
    expect(aberto[0]).toMatch(/disponibilização 01\/10\/2026/);
  });
});

describe('sonda-avisos-pendentes · analisador da resposta', () => {
  it('lê dez avisos como o WSDL os descreve: tipo e disponibilização em todos, nenhum prazo', async () => {
    const s = await carregar();
    const analise = s.analisarResposta(conteudoDe(resposta(dezAvisos())));
    expect(analise.avisos).toHaveLength(10);
    expect(analise.chaveDaLista).toBe('aviso');
    const nomes = new Set(analise.avisos.flatMap((a) => a.campos.map((c) => c.nome)));
    expect([...nomes].sort()).toEqual(
      [
        '@idAviso',
        '@tipoComunicacao',
        'dataDisponibilizacao',
        'destinatario',
        'processo/@classeProcessual',
        'processo/@numero',
      ].sort(),
    );

    const r = s.resumir(s.montarTabela({ ...analise, acompanhados: null }), {
      esperado: 10,
    });
    expect(r.tipos).toEqual({ Citação: 4, Intimação: 6 });
    expect(r.publicacao.comData).toBe(10);
    expect(r.limite.campoExiste).toBe(false);
    expect(s.julgar(r)).toMatchObject({ rotulo: 'COMPATÍVEL' });
    expect(s.julgar(r).motivo).toMatch(/não traz prazo nem data limite \(esperado/);
  });

  it.each([
    ['ts', 'AAAAMMDDhhmmss'],
    ['iso', 'ISO com hora'],
    ['br', 'dd/MM/AAAA'],
  ] as const)(
    'reconhece a disponibilização no formato %s e normaliza para o mesmo dia',
    async (formato, nome) => {
      const s = await carregar();
      const analise = s.analisarResposta(conteudoDe(resposta([aviso(0, { formato })])));
      const d = analise.avisos[0]?.datas.find((x) => x.papel === 'publicacao');
      expect(d).toMatchObject({ formato: nome, valor: '2026-10-01' });
    },
  );

  it.each(['ns-numerados', 'prefixos-outros', 'padrao-inline'] as const)(
    'dá o MESMO resultado com prefixos diferentes (%s): o namespace manda, o prefixo não',
    async (estilo) => {
      const s = await carregar();
      const analise = s.analisarResposta(conteudoDe(resposta(dezAvisos(estilo), estilo)));
      expect(analise.chaveDaLista).toBe('aviso');
      expect(analise.avisos).toHaveLength(10);
      const referencia = s.analisarResposta(conteudoDe(resposta(dezAvisos())));
      expect(analise.avisos).toEqual(referencia.avisos);
      expect(analise.numerosPorAviso).toEqual(referencia.numerosPorAviso);
    },
  );

  it('se o tribunal mandar data limite (o WSDL não prevê), a sonda acusa como INESPERADO', async () => {
    const s = await carregar();
    const analise = s.analisarResposta(
      conteudoDe(resposta([aviso(0, { comLimite: true }), aviso(1)])),
    );
    const r = s.resumir(s.montarTabela({ ...analise, acompanhados: null }), {
      esperado: 2,
    });
    expect(r.limite).toMatchObject({
      campoExiste: true,
      campos: ['dataLimite'],
      preenchidos: 1,
    });
    expect(s.julgar(r).motivo).toMatch(/o WSDL não prevê/);
  });

  it('lista vazia: zero avisos, NÃO CONFIRMÁVEL', async () => {
    const s = await carregar();
    const analise = s.analisarResposta(
      conteudoDe(
        resposta([], 'ns-numerados', '<ns2:mensagem>Nenhum aviso.</ns2:mensagem>'),
      ),
    );
    expect(analise.avisos).toHaveLength(0);
    const r = s.resumir(s.montarTabela({ ...analise, acompanhados: null }), {
      esperado: 10,
    });
    expect(s.julgar(r)).toMatchObject({ rotulo: 'NÃO CONFIRMÁVEL' });
  });

  it('um único aviso (objeto, não lista) também é lido', async () => {
    const s = await carregar();
    const analise = s.analisarResposta(conteudoDe(resposta([aviso(2)])));
    expect(analise.avisos).toHaveLength(1);
    expect(analise.numerosPorAviso[0]).toEqual([
      (NUMEROS[2] as string).replace(/\D/g, ''),
    ]);
  });

  it('desce num invólucro <avisos><aviso>…</aviso></avisos>', async () => {
    const s = await carregar();
    const xml = resposta([`<ns2:avisos>${[aviso(0), aviso(1)].join('')}</ns2:avisos>`]);
    const analise = s.analisarResposta(conteudoDe(xml));
    expect(analise.avisos).toHaveLength(2);
    expect(analise.chaveDaLista).toBe('avisos/aviso');
  });

  it('tolera campos inesperados: registra nome e formato, sem derrubar nem inventar papel', async () => {
    const s = await carregar();
    const estranho =
      `<ns2:aviso><ns2:campoNovoDoTribunal>abc</ns2:campoNovoDoTribunal><ns2:outro><ns2:fundo>1</ns2:fundo></ns2:outro>` +
      `<ns2:prazoEmDias>15</ns2:prazoEmDias><ns2:prazoFinal>21/10/2026</ns2:prazoFinal></ns2:aviso>`;
    const analise = s.analisarResposta(conteudoDe(resposta([estranho])));
    const campos = Object.fromEntries(
      (analise.avisos[0]?.campos ?? []).map((c) => [c.nome, c]),
    );
    expect(campos['campoNovoDoTribunal']).toMatchObject({
      papel: 'outro',
      formato: 'texto curto',
    });
    expect(campos['outro/fundo']).toMatchObject({ formato: 'só dígitos (1)' });
    expect(campos['prazoEmDias']).toMatchObject({ papel: 'prazo' });
    expect(campos['prazoFinal']).toMatchObject({
      papel: 'limite',
      formato: 'dd/MM/AAAA',
    });
  });

  it('data inválida (mês 13) não vira data', async () => {
    const s = await carregar();
    expect(s.lerData('20261301093000')).toBeUndefined();
    expect(s.lerData('20261020')?.iso).toBe('2026-10-20');
    expect(s.formatoDe('20261301093000')).toBe('só dígitos (14)');
  });

  it('cruza os avisos com a carteira só por contagem', async () => {
    const s = await carregar();
    const analise = s.analisarResposta(conteudoDe(resposta(dezAvisos())));
    const carteira = new Set(
      NUMEROS.slice(0, 4)
        .map((n) => n.replace(/\D/g, ''))
        .concat('99999999999999999999'),
    );
    expect(s.contarAcompanhados(analise.numerosPorAviso, carteira)).toEqual({
      avisosComProcesso: 10,
      acompanhados: 4,
      totalCarteira: 5,
    });
  });
});

describe('sonda-avisos-pendentes · julgamento', () => {
  const resumoDe = async (avisos: string[], esperado?: number): Promise<Resumo> => {
    const s = await carregar();
    const a = s.analisarResposta(conteudoDe(resposta(avisos)));
    return s.resumir(
      s.montarTabela({ ...a, acompanhados: null }),
      esperado === undefined ? {} : { esperado },
    );
  };

  it('COMPATÍVEL: quantidade igual, tipo e disponibilização presentes; sem data limite NÃO é falha', async () => {
    const s = await carregar();
    const j = s.julgar(await resumoDe(dezAvisos(), 10));
    expect(j.rotulo).toBe('COMPATÍVEL');
    expect(j.motivo).toMatch(/conferência visual/);
  });

  it('PARCIAL quando vêm menos avisos que a tela', async () => {
    const s = await carregar();
    expect(s.julgar(await resumoDe(dezAvisos().slice(0, 6), 10))).toMatchObject({
      rotulo: 'PARCIAL',
    });
  });

  it('PARCIAL quando algum aviso vem sem tipoComunicacao', async () => {
    const s = await carregar();
    const avisos = NUMEROS.map((_, i) => aviso(i, i === 4 ? { tipo: null } : {}));
    const j = s.julgar(await resumoDe(avisos, 10));
    expect(j).toMatchObject({ rotulo: 'PARCIAL' });
    expect(j.motivo).toMatch(/1 sem tipoComunicacao/);
  });

  it('PARCIAL quando algum aviso vem sem dataDisponibilizacao', async () => {
    const s = await carregar();
    const avisos = NUMEROS.map((_, i) =>
      aviso(i, i < 2 ? { disponibilizacao: null } : {}),
    );
    const j = s.julgar(await resumoDe(avisos, 10));
    expect(j).toMatchObject({ rotulo: 'PARCIAL' });
    expect(j.motivo).toMatch(/2 sem dataDisponibilizacao/);
  });

  it('PARCIAL sem --esperado: sem referência não se afirma completude', async () => {
    const s = await carregar();
    expect(s.julgar(await resumoDe(dezAvisos()))).toMatchObject({ rotulo: 'PARCIAL' });
  });

  it('NÃO CONFIRMÁVEL quando vêm MAIS avisos que a tela (a lista não é a mesma)', async () => {
    const s = await carregar();
    expect(s.julgar(await resumoDe(dezAvisos(), 7))).toMatchObject({
      rotulo: 'NÃO CONFIRMÁVEL',
    });
  });

  it('o argumento --sem-limite-esperado foi removido', async () => {
    const s = await carregar();
    expect(() => s.lerArgumentos(['--sem-limite-esperado=2'])).toThrow();
  });
});

describe('sonda-avisos-pendentes · tabela e --offline', () => {
  it('a tabela não contém número de processo, texto livre nem nome — mas guarda tipo e datas', async () => {
    const s = await carregar();
    const analise = s.analisarResposta(conteudoDe(resposta(dezAvisos())));
    const texto = JSON.stringify(
      s.validarTabela(s.montarTabela({ ...analise, acompanhados: null })),
    );
    for (const n of NUMEROS) {
      expect(texto).not.toContain(n);
      expect(texto).not.toContain(n.replace(/\D/g, ''));
    }
    expect(texto).not.toMatch(/Fulano|Sintetico/);
    expect(texto).toContain('Citação');
    expect(texto).toContain('2026-10-01');
    expect(texto).toContain('dataDisponibilizacao');
  });

  it('recusa tabela com forma de número de processo', async () => {
    const s = await carregar();
    expect(() =>
      s.validarTabela({ avisos: [{ campos: [{ nome: NUMEROS[0] }], datas: [] }] }),
    ).toThrow(/número de processo/);
    expect(() => s.validarTabela({ semAvisos: true })).toThrow();
  });

  it('--offline lê a tabela, imprime resumo e julgamento, e não chama banco, rede nem escrita', async () => {
    const s = await carregar();
    const analise = s.analisarResposta(conteudoDe(resposta(dezAvisos())));
    const tabela = s.montarTabela({
      ...analise,
      acompanhados: { avisosComProcesso: 10, acompanhados: 4, totalCarteira: 5 },
    });
    const pasta = novaPasta();
    const arquivo = join(pasta, 'tabela.json');
    writeFileSync(arquivo, JSON.stringify(tabela));

    const proibido = vi.fn(() => {
      throw new Error('não podia ser chamado');
    });
    const deps: Deps = {
      tmpdir: () => pasta,
      lerArquivo: (c) => readFileSync(c, 'utf8'),
      gravarArquivo: proibido,
      carregarContexto: proibido,
      baixarDocumento: proibido,
      consultarAvisos: proibido,
    };
    const saida: string[] = [];
    const codigo = await s.principal(
      [`--offline=${arquivo}`, '--esperado=10'],
      deps,
      (l) => saida.push(l),
    );
    expect(codigo).toBe(0);
    expect(proibido).not.toHaveBeenCalled();
    const texto = saida.join('\n');
    expect(texto).toContain('avisos recebidos: 10');
    expect(texto).toContain('4 de 10 avisos são de processo acompanhado');
    expect(texto).toContain('ACHADO ESPERADO');
    expect(texto).toMatch(/COMPATÍVEL/);
    expect(texto).toMatch(/não conseguiu medir/);
    expect(texto).not.toMatch(/Fulano/);
  });
});

describe('sonda-avisos-pendentes · --seco', () => {
  it('mostra o envelope sem senha e não chama banco, rede nem disco', async () => {
    const s = await carregar();
    const proibido = vi.fn(() => {
      throw new Error('não podia ser chamado');
    });
    const deps: Deps = {
      tmpdir: () => '/tmp',
      lerArquivo: proibido,
      gravarArquivo: proibido,
      carregarContexto: proibido,
      baixarDocumento: proibido,
      consultarAvisos: proibido,
    };
    const saida: string[] = [];
    expect(await s.principal(['--seco'], deps, (l) => saida.push(l))).toBe(0);
    expect(proibido).not.toHaveBeenCalled();
    const texto = saida.join('\n');
    expect(texto).toContain('consultarAvisosPendentes');
    expect(texto).toContain('(omitido)');
    expect(texto).toContain('confirmarRecebimento');
    expect(texto).toContain('sonda-avisos-pendentes-tabela.json');
  });

  it('o topo do script não importa banco nem dist/ (só os modos reais os carregam)', () => {
    const fonte = readFileSync(CAMINHO, 'utf8');
    const estaticos = fonte.split('\n').filter((l) => /^import /.test(l));
    expect(estaticos.join('\n')).not.toMatch(/node:sqlite|dist\//);
    const idx = fonte.indexOf('export function dependenciasReais');
    expect(fonte.indexOf("await import('node:sqlite')")).toBeGreaterThan(idx);
    expect(fonte.indexOf("await import('../dist/")).toBeGreaterThan(idx);
  });

  it('roda de verdade como processo, de outro diretório, sem dist/ nem banco', () => {
    const cwd = novaPasta();
    const saida = execFileSync(process.execPath, [CAMINHO, '--seco'], {
      cwd,
      env: { PATH: process.env['PATH'] ?? '', HTTPS_PROXY: 'http://127.0.0.1:9' },
      encoding: 'utf8',
    });
    expect(saida).toContain('--seco: nada foi aberto nem enviado');
  });

  it('recusa argumento desconhecido e modos incompatíveis', async () => {
    const s = await carregar();
    expect(() => s.lerArgumentos(['--confirmar'])).toThrow();
    expect(() => s.lerArgumentos(['--esperado=dez'])).toThrow();
    expect(() => s.lerArgumentos(['--seco', '--wsdl'])).toThrow(/incompatíveis/);
    expect(s.lerArgumentos(['--esperado=10', '--mostrar'])).toEqual({
      esperado: '10',
      mostrar: true,
    });
  });
});

describe('sonda-avisos-pendentes · WSDL', () => {
  it('descreve a entrada (quatro opcionais, em ordem) e a saída; o tipo de aviso vem de outro arquivo', async () => {
    const s = await carregar();
    const a = s.analisarWsdl(
      juntos(WSDL_PRINCIPAL('Retorna a lista de avisos pendentes do consultante.')),
    );
    const op = a.operacoes['consultarAvisosPendentes'] as Op;
    expect(op.encontrada).toBe(true);
    expect(op.entrada.namespace).toBe(NS_SERVICO);
    expect(op.entrada.filhos.map((f) => `${f.nome}:${f.minOccurs}`)).toEqual([
      'idRepresentado:0',
      'idConsultante:0',
      'senhaConsultante:0',
      'dataReferencia:0',
    ]);
    expect(op.saida.filhos.map((f) => f.nome)).toEqual(['sucesso', 'mensagem', 'aviso']);
    expect(op.saida.filhos[2]?.filhos.map((f) => f.nome)).toEqual([
      'destinatario',
      'processo',
      'dataDisponibilizacao',
      '@idAviso',
      '@tipoComunicacao',
    ]);
    expect(op.soapAction).toMatch(/consultarAvisosPendentes$/);
  });

  it('só com o arquivo do WSDL (sem o esquema importado) a análise percebe que falta o tipo', async () => {
    const s = await carregar();
    const a = s.analisarWsdl(new Map([['wsdl', WSDL_PRINCIPAL()]]));
    expect((a.operacoes['consultarAvisosPendentes'] as Op).entrada.filhos).toEqual([]);
    expect(s.avaliarWsdl(a).abortar.join(' ')).toMatch(/idConsultante/);
  });

  it('descreve consultarRelatorioDeIntimacoesTJGO sem chamá-la', async () => {
    const s = await carregar();
    const a = s.analisarWsdl(juntos());
    const rel = a.operacoes['consultarRelatorioDeIntimacoesTJGO'] as Op;
    expect(rel.encontrada).toBe(true);
    const req = rel.entrada.filhos[0] as No;
    expect(req.nome).toBe('requisicaoCredenciaisTJGO');
    expect(req.filhos.map((f) => f.nome)).toEqual([
      'grupoCodigo',
      'id_UsuarioServentiaChefe',
      'id_serventiaCargo',
      'id_serventiaCargoUsuarioChefe',
      'id_usuarioServentia',
      'loginConsultante',
      'senhaConsultante',
    ]);
    expect(req.filhos.every((f) => f.minOccurs === '0')).toBe(true);
    expect(rel.saida.filhos.map((f) => f.nome)).toEqual([
      'conteudoArquivo',
      'nomeArquivo',
      'quantidadeDeRegistros',
    ]);
    expect(a.proibidasPresentes).toEqual(['confirmarRecebimento']);
  });

  it('--wsdl-arquivo aceita vários arquivos, imprime tudo e não chama banco, rede nem a consulta', async () => {
    const s = await carregar();
    const arquivos: Record<string, string> = {
      'a.wsdl': WSDL_PRINCIPAL('Lista os avisos.'),
      'b.xsd': XSD(),
    };
    const proibido = vi.fn(() => {
      throw new Error('não podia ser chamado');
    });
    const deps: Deps = {
      tmpdir: () => '/tmp',
      lerArquivo: (c) => arquivos[c] as string,
      gravarArquivo: proibido,
      carregarContexto: proibido,
      baixarDocumento: proibido,
      consultarAvisos: proibido,
    };
    const saida: string[] = [];
    expect(
      await s.principal(['--wsdl-arquivo=a.wsdl,b.xsd'], deps, (l) => saida.push(l)),
    ).toBe(0);
    expect(proibido).not.toHaveBeenCalled();
    const texto = saida.join('\n');
    expect(texto).toMatch(/consultarRelatorioDeIntimacoesTJGO .*SÓ DESCRITA/);
    expect(texto).toContain('requisicaoCredenciaisTJGO');
    expect(texto).toContain('quantidadeDeRegistros');
    expect(texto).toContain('@tipoComunicacao');
    expect(texto).toMatch(/não declara prazo nem data limite/);
    expect(texto).toMatch(/OK: a entrada é montável/);
  });

  it('autoriza a consulta com entrada toda opcional e nada de prazo no aviso', async () => {
    const s = await carregar();
    const av = s.avaliarWsdl(
      s.analisarWsdl(juntos(WSDL_PRINCIPAL('Retorna a lista de avisos.'))),
    );
    expect(av.abortar).toEqual([]);
    expect(av.acao).toBe(s.ACAO_AVISOS);
    expect(av.avisos.join(' ')).toMatch(/não declara prazo nem data limite/);
  });

  it('PARA quando a entrada exige elemento que o envelope não monta', async () => {
    const s = await carregar();
    const av = s.avaliarWsdl(
      s.analisarWsdl(juntos(WSDL_PRINCIPAL(), XSD({ obrigatorioExtra: true }))),
    );
    expect(av.abortar.join(' ')).toMatch(/codigoNovo/);
  });

  it('PARA quando a ordem de id/senha no WSDL é outra', async () => {
    const s = await carregar();
    const av = s.avaliarWsdl(
      s.analisarWsdl(juntos(WSDL_PRINCIPAL(), XSD({ ordem: 'trocada' }))),
    );
    expect(av.abortar.join(' ')).toMatch(/ordem/);
  });

  it('PARA quando a documentação indica efeito colateral; só avisa quando é ambígua', async () => {
    const s = await carregar();
    const forte = s.avaliarWsdl(
      s.analisarWsdl(juntos(WSDL_PRINCIPAL('Lista os avisos e marca como lido.'))),
    );
    expect(forte.abortar.join(' ')).toMatch(/efeito colateral/);
    const fraco = s.avaliarWsdl(
      s.analisarWsdl(juntos(WSDL_PRINCIPAL('Avisos pendentes de ciência.'))),
    );
    expect(fraco.abortar).toEqual([]);
    expect(fraco.avisos.join(' ')).toMatch(/ciência/);
    expect(
      s.indiciosDeEfeitoColateral('Registra ciência da intimação').fortes.length,
    ).toBeGreaterThan(0);
  });

  it('sem documentação, avisa que a ausência de efeito colateral não está provada', async () => {
    const s = await carregar();
    const av = s.avaliarWsdl(s.analisarWsdl(juntos()));
    expect(av.avisos.join(' ')).toMatch(/NÃO está provada/);
  });

  it('PARA quando o WSDL não declara a operação', async () => {
    const s = await carregar();
    const w = WSDL_PRINCIPAL().replaceAll('consultarAvisosPendentes', 'outraCoisa');
    const av = s.avaliarWsdl(s.analisarWsdl(juntos(w, XSD())));
    expect(av.abortar.join(' ')).toMatch(/não declara/);
  });

  it('baixa só o mesmo host, só GET dos importados, com teto de documentos', async () => {
    const s = await carregar();
    const raiz = `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"><types><schema xmlns="http://www.w3.org/2001/XMLSchema">
      <import schemaLocation="https://projudi.exemplo/svc?xsd=1"/><import schemaLocation="https://outro.host/x.xsd"/></schema></types></definitions>`;
    const baixar = vi.fn(async (u: string) =>
      u.endsWith('WSDL') ? raiz : '<schema xmlns="http://www.w3.org/2001/XMLSchema"/>',
    );
    const docs = await s.baixarWsdlCompleto(baixar, 'https://projudi.exemplo/svc?WSDL');
    expect([...docs.keys()]).toEqual([
      'https://projudi.exemplo/svc?WSDL',
      'https://projudi.exemplo/svc?xsd=1',
    ]);
    expect(baixar).not.toHaveBeenCalledWith('https://outro.host/x.xsd');
  });
});

describe('sonda-avisos-pendentes · fluxo da consulta real (dublado)', () => {
  const contexto = {
    workspace: 'ws-teste',
    identificacao: 'adv-sintetico',
    carteira: new Set(NUMEROS.slice(0, 3).map((n) => n.replace(/\D/g, ''))),
    endpoint: 'https://tribunal.exemplo/IntercomunicacaoService',
  };

  function montarDeps(o: {
    wsdl: Map<string, string>;
    resposta?: string;
    falha?: Error;
  }): {
    deps: Deps;
    gravados: Map<string, string>;
    consultar: ReturnType<typeof vi.fn>;
  } {
    const gravados = new Map<string, string>();
    const consultar = vi.fn(async () => {
      if (o.falha) throw o.falha;
      return {
        conteudo: conteudoDe(o.resposta ?? ''),
        mensagem: '',
        bytes: 1234,
        ms: 900,
      };
    });
    return {
      gravados,
      consultar,
      deps: {
        tmpdir: () => '/tmp/sonda-spec',
        lerArquivo: () => '',
        gravarArquivo: (c, t) => void gravados.set(c, t),
        carregarContexto: async () => contexto,
        // o WSDL "principal" referencia o esquema por URL: devolve cada um pelo nome
        baixarDocumento: async (u) =>
          u.includes('xsd')
            ? (o.wsdl.get('xsd') as string)
            : (o.wsdl.get('wsdl') as string),
        consultarAvisos: consultar,
      },
    };
  }

  it('consulta UMA vez, grava a tabela sem dado pessoal e não imprime número, nome ou texto', async () => {
    const s = await carregar();
    const { deps, gravados, consultar } = montarDeps({
      wsdl: juntos(WSDL_PRINCIPAL('Lista os avisos.')),
      resposta: resposta(dezAvisos()),
    });
    const saida: string[] = [];
    const codigo = await s.principal(['--esperado=10'], deps, (l) => saida.push(l));
    expect(codigo).toBe(0);
    expect(consultar).toHaveBeenCalledTimes(1);
    const texto = saida.join('\n');
    expect(texto).toContain('3 de 10 avisos são de processo acompanhado');
    expect(texto).toContain('COMPATÍVEL');
    expect(texto).toContain('*******-**.****.8.09.****');
    for (const n of NUMEROS) expect(texto).not.toContain(n);
    expect(texto).not.toMatch(/Fulano|Sintetico|\d{2}\/\d{2}\/2026/);

    const [caminho, conteudo] = [...gravados.entries()][0] ?? ['', ''];
    expect(caminho).toBe('/tmp/sonda-spec/sonda-avisos-pendentes-tabela.json');
    for (const n of NUMEROS) expect(conteudo).not.toContain(n.replace(/\D/g, ''));
    expect(JSON.parse(conteudo as string).acompanhados).toEqual({
      avisosComProcesso: 10,
      acompanhados: 3,
      totalCarteira: 3,
    });
  });

  it('com --mostrar imprime número e datas no terminal, e não os grava no arquivo', async () => {
    const s = await carregar();
    const { deps, gravados } = montarDeps({
      wsdl: juntos(WSDL_PRINCIPAL('Lista os avisos.')),
      resposta: resposta(dezAvisos()),
    });
    const saida: string[] = [];
    await s.principal(['--mostrar', '--esperado=10'], deps, (l) => saida.push(l));
    const texto = saida.join('\n');
    expect(texto).toContain(NUMEROS[0]);
    expect(texto).toMatch(/disponibilização 01\/10\/2026/);
    expect([...gravados.values()].join('')).not.toContain(NUMEROS[0]);
  });

  it('não toca na credencial quando o WSDL não autoriza', async () => {
    const s = await carregar();
    const { deps, consultar } = montarDeps({
      wsdl: juntos(WSDL_PRINCIPAL('Marca como lido.')),
    });
    const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const codigo = await s.principal([], deps, () => undefined);
    erro.mockRestore();
    expect(codigo).toBe(2);
    expect(consultar).not.toHaveBeenCalled();
  });

  it('aborta (código 2) quando o tribunal falha, sem segunda tentativa', async () => {
    const s = await carregar();
    const { deps, consultar } = montarDeps({
      wsdl: juntos(WSDL_PRINCIPAL('Lista os avisos.')),
      falha: new s.SondaAbortada('o tribunal respondeu HTTP 403'),
    });
    const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const codigo = await s.principal([], deps, () => undefined);
    expect(codigo).toBe(2);
    expect(consultar).toHaveBeenCalledTimes(1);
    expect(erro.mock.calls.flat().join(' ')).toMatch(/403/);
    erro.mockRestore();
  });
});

describe('sonda-avisos-pendentes · versão', () => {
  it('segue na 1.0.0 (ajustes ao WSDL, antes de qualquer execução real)', async () => {
    expect((await carregar()).VERSAO_SONDA).toBe('1.0.0');
  });
});
