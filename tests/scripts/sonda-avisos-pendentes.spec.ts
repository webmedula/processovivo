import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { abrirEnvelope } from '../../src/infrastructure/adapters/mni/mni.mapper.js';
import { MniAdapter } from '../../src/infrastructure/adapters/mni/MniAdapter.js';

/**
 * A sonda é um script `.mjs` (como as outras), então entra por import dinâmico de
 * um caminho em variável: o TypeScript não tenta tipá-lo, e o contrato que
 * importa está descrito aqui.
 *
 * Fixtures SINTÉTICAS, sempre: a forma real de `consultarAvisosPendentes` ainda
 * não foi capturada (é para isso que a sonda existe). Os campos abaixo são o
 * palpite do MNI 2.2.2 e as variações que a sonda tem de tolerar — por isso não
 * há aqui nenhum teste que "prove" o formato do tribunal.
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
  limite: {
    campoExiste: boolean;
    campos: string[];
    preenchidos: number;
    vazios: number;
    ausentes: number;
    semLimite: number;
    formatos: string[];
  };
  publicacao: { comData: number; formatos: string[] };
  diasPublicacaoAteLimite: { n: number; min: number; max: number } | null;
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
interface Sonda {
  VERSAO_SONDA: string;
  OPERACAO: string;
  ACAO_AVISOS: string;
  OPERACOES_PROIBIDAS: readonly string[];
  OperacaoProibidaError: new (...a: never[]) => Error;
  SondaAbortada: new (m: string) => Error;
  garantirOperacaoPermitida(o: string): void;
  validarEnvelopeEAcao(xml: string, acao: string): void;
  envelopeAvisosPendentes(c: { identificacao: string; senha: string }): string;
  envelopeParaExibir(): string;
  mascararNumeroProcesso(t: string): string;
  formatarNumeroCnj(d: string): string;
  lerData(v: string): { formato: string; iso: string } | undefined;
  formatoDe(v: string): string;
  papelDoCampo(c: string, v: string): string;
  analisarResposta(conteudo: unknown): Analise;
  montarTabela(a: unknown): Tabela;
  validarTabela(b: unknown): Tabela;
  resumir(t: Tabela, o?: { esperado?: number; semLimiteEsperado?: number }): Resumo;
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
interface Op {
  encontrada: boolean;
  documentacao?: string;
  soapAction?: string;
  entrada: {
    elemento: string;
    namespace?: string;
    filhos: { nome: string; minOccurs: string; filhos: unknown[] }[];
  };
  saida: { elemento: string; filhos: { nome: string; filhos: { nome: string }[] }[] };
}
interface WsdlAnalise {
  operacoesDoServico: string[];
  proibidasPresentes: string[];
  operacoes: Record<string, Op>;
}

const CAMINHO = resolve(__dirname, '../../scripts/sonda-avisos-pendentes.mjs');
const carregar = async (): Promise<Sonda> =>
  (await import(/* @vite-ignore */ CAMINHO)) as unknown as Sonda;

// --- fixtures sintéticas ---------------------------------------------------------
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

function aviso(
  i: number,
  opcoes: {
    limite?: 'preenchido' | 'vazio' | 'ausente';
    formato?: 'ts' | 'iso' | 'br';
    tipo?: string;
  },
): string {
  const { limite = 'preenchido', formato = 'ts', tipo = 'Intimação' } = opcoes;
  const data = (d: string): string =>
    formato === 'ts'
      ? `${d.replaceAll('-', '')}093000`
      : formato === 'iso'
        ? `${d}T09:30:00`
        : d.split('-').reverse().join('/');
  const lim =
    limite === 'preenchido'
      ? `<ns2:dataLimite>${data(`2026-10-${20 + (i % 5)}`)}</ns2:dataLimite>`
      : limite === 'vazio'
        ? '<ns2:dataLimite/>'
        : '';
  return (
    `<ns2:aviso idAviso="${9000 + i}" tipoComunicacao="${tipo}">` +
    `<ns3:processo numero="${NUMEROS[i]}" classeProcessual="7"/>` +
    `<ns2:destinatario>Fulano Sintetico de Tal</ns2:destinatario>` +
    `<ns2:descricao>Texto livre do ato que nunca pode sair</ns2:descricao>` +
    `<ns2:dataDisponibilizacao>${data(`2026-10-0${1 + (i % 5)}`)}</ns2:dataDisponibilizacao>` +
    lim +
    `</ns2:aviso>`
  );
}

function resposta(avisos: string[], extra = ''): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<ns5:consultarAvisosPendentesResposta xmlns:ns2="http://www.cnj.jus.br/tipos-servico-intercomunicacao-2.2.2" xmlns:ns3="http://www.cnj.jus.br/intercomunicacao-2.2.2" xmlns:ns5="http://www.cnj.jus.br/servico-intercomunicacao-2.2.2/">` +
    `<ns2:sucesso>true</ns2:sucesso>${extra}${avisos.join('')}` +
    `</ns5:consultarAvisosPendentesResposta></soap:Body></soap:Envelope>`
  );
}
const conteudoDe = (xml: string): unknown => abrirEnvelope(xml).conteudo;

/** Dez avisos: oito com data limite, um com o campo vazio e um sem o campo. */
function dezAvisos(): string[] {
  return NUMEROS.map((_, i) =>
    aviso(i, {
      limite: i === 3 ? 'vazio' : i === 7 ? 'ausente' : 'preenchido',
      tipo: i % 3 === 0 ? 'Citação' : 'Intimação',
    }),
  );
}

const WSDL = (
  opcoes: { doc?: string; extraObrigatorio?: boolean; ordem?: 'ok' | 'trocada' } = {},
): string => {
  const { doc = '', extraObrigatorio = false, ordem = 'ok' } = opcoes;
  const id = '<xs:element name="idConsultante" type="xs:string"/>';
  const senha = '<xs:element name="senhaConsultante" type="xs:string"/>';
  return `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:xs="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="http://www.cnj.jus.br/servico-intercomunicacao-2.2.2/"
  targetNamespace="http://www.cnj.jus.br/servico-intercomunicacao-2.2.2/">
 <wsdl:types>
  <xs:schema targetNamespace="http://www.cnj.jus.br/servico-intercomunicacao-2.2.2/">
   <xs:element name="consultarAvisosPendentes"><xs:complexType><xs:sequence>
     ${ordem === 'ok' ? id + senha : senha + id}
     <xs:element name="idRepresentado" type="xs:string" minOccurs="0" maxOccurs="unbounded"/>
     <xs:element name="dataReferencia" type="xs:string" minOccurs="0"/>
     ${extraObrigatorio ? '<xs:element name="codigoNovo" type="xs:string"/>' : ''}
   </xs:sequence></xs:complexType></xs:element>
   <xs:element name="consultarAvisosPendentesResposta"><xs:complexType><xs:sequence>
     <xs:element name="sucesso" type="xs:boolean"/>
     <xs:element name="mensagem" type="xs:string"/>
     <xs:element name="aviso" type="tns:tipoAviso" minOccurs="0" maxOccurs="unbounded"/>
   </xs:sequence></xs:complexType></xs:element>
   <xs:complexType name="tipoAviso"><xs:sequence>
     <xs:element name="processo" type="xs:string"/>
     <xs:element name="dataLimite" type="xs:string" minOccurs="0"/>
   </xs:sequence><xs:attribute name="idAviso" type="xs:string" use="required"/></xs:complexType>
   <xs:element name="consultarRelatorioDeIntimacoesTJGO"><xs:complexType><xs:sequence>
     <xs:element name="idConsultante" type="xs:string"/><xs:element name="senhaConsultante" type="xs:string"/>
     <xs:element name="inicio" type="xs:string"/>
   </xs:sequence></xs:complexType></xs:element>
   <xs:element name="consultarRelatorioDeIntimacoesTJGOResposta"><xs:complexType><xs:sequence>
     <xs:element name="sucesso" type="xs:boolean"/>
   </xs:sequence></xs:complexType></xs:element>
   <xs:element name="confirmarRecebimento"><xs:complexType><xs:sequence><xs:element name="x" type="xs:string"/></xs:sequence></xs:complexType></xs:element>
  </xs:schema>
 </wsdl:types>
 <wsdl:message name="avisosIn"><wsdl:part name="p" element="tns:consultarAvisosPendentes"/></wsdl:message>
 <wsdl:message name="avisosOut"><wsdl:part name="p" element="tns:consultarAvisosPendentesResposta"/></wsdl:message>
 <wsdl:message name="relIn"><wsdl:part name="p" element="tns:consultarRelatorioDeIntimacoesTJGO"/></wsdl:message>
 <wsdl:message name="relOut"><wsdl:part name="p" element="tns:consultarRelatorioDeIntimacoesTJGOResposta"/></wsdl:message>
 <wsdl:message name="confIn"><wsdl:part name="p" element="tns:confirmarRecebimento"/></wsdl:message>
 <wsdl:message name="confOut"><wsdl:part name="p" element="tns:confirmarRecebimento"/></wsdl:message>
 <wsdl:portType name="Svc">
  <wsdl:operation name="consultarAvisosPendentes">
   ${doc ? `<wsdl:documentation>${doc}</wsdl:documentation>` : ''}
   <wsdl:input message="tns:avisosIn"/><wsdl:output message="tns:avisosOut"/>
  </wsdl:operation>
  <wsdl:operation name="consultarRelatorioDeIntimacoesTJGO"><wsdl:input message="tns:relIn"/><wsdl:output message="tns:relOut"/></wsdl:operation>
  <wsdl:operation name="confirmarRecebimento"><wsdl:input message="tns:confIn"/><wsdl:output message="tns:confOut"/></wsdl:operation>
 </wsdl:portType>
 <wsdl:binding name="B" type="tns:Svc">
  <wsdl:operation name="consultarAvisosPendentes"><soap:operation soapAction="http://www.cnj.jus.br/servico-intercomunicacao-2.2.2/consultarAvisosPendentes"/></wsdl:operation>
 </wsdl:binding>
</wsdl:definitions>`;
};

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

  it('só deixa passar consultarAvisosPendentes (lista de permissão)', async () => {
    const s = await carregar();
    expect(() => s.garantirOperacaoPermitida('consultarAvisosPendentes')).not.toThrow();
    expect(() => s.garantirOperacaoPermitida(s.ACAO_AVISOS)).not.toThrow();
    for (const outra of [
      'consultarProcesso',
      'consultarAlteracao',
      '',
      'consultarAvisosPendentesX',
    ]) {
      expect(() => s.garantirOperacaoPermitida(outra)).toThrow();
    }
  });

  it('o envelope montado é aceito e tem a ordem obrigatória do xs:sequence', async () => {
    const s = await carregar();
    const xml = s.envelopeAvisosPendentes({ identificacao: 'adv', senha: 'a&b<c' });
    expect(() => s.validarEnvelopeEAcao(xml, s.ACAO_AVISOS)).not.toThrow();
    expect(xml.indexOf('idConsultante')).toBeLessThan(xml.indexOf('senhaConsultante'));
    expect(xml).toContain('<srv:consultarAvisosPendentes>');
    expect(xml).toContain('a&amp;b&lt;c'); // senha com & e < não quebra o XML
    expect(xml).not.toMatch(/idRepresentado|dataReferencia/); // opcionais ficam de fora
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
    // E a sonda não cria rate limiter nem HttpClient próprio para o envio.
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

    const aberto = s.linhasDeConferencia(analise, { mostrar: true });
    expect(aberto[0]).toContain(NUMEROS[0]);
    expect(aberto[0]).toMatch(/publicação 01\/10\/2026 · data limite 20\/10\/2026/);
    expect(aberto[3]).toContain('data limite — (sem)'); // o aviso de campo vazio
  });
});

describe('sonda-avisos-pendentes · analisador da resposta', () => {
  it('conta os dez avisos, acha o campo de data limite e os dois que não têm', async () => {
    const s = await carregar();
    const analise = s.analisarResposta(conteudoDe(resposta(dezAvisos())));
    expect(analise.avisos).toHaveLength(10);
    expect(analise.chaveDaLista).toBe('aviso');

    const tabela = s.montarTabela({ ...analise, acompanhados: null });
    const r = s.resumir(tabela, { esperado: 10, semLimiteEsperado: 2 });
    expect(r.total).toBe(10);
    expect(r.limite).toMatchObject({
      campoExiste: true,
      campos: ['dataLimite'],
      preenchidos: 8,
      vazios: 1,
      ausentes: 1,
      semLimite: 2,
      formatos: expect.arrayContaining(['AAAAMMDDhhmmss', 'vazio']),
    });
    expect(r.diasPublicacaoAteLimite).toMatchObject({ n: 8 });
    expect(r.tipos).toEqual({ Citação: 4, Intimação: 6 });
    expect(s.julgar(r).rotulo).toBe('COMPATÍVEL');
  });

  it.each([
    ['ts', 'AAAAMMDDhhmmss'],
    ['iso', 'ISO com hora'],
    ['br', 'dd/MM/AAAA'],
  ] as const)(
    'reconhece a data no formato %s e normaliza para o mesmo dia',
    async (formato, nome) => {
      const s = await carregar();
      const analise = s.analisarResposta(conteudoDe(resposta([aviso(0, { formato })])));
      const lim = analise.avisos[0]?.datas.find((d) => d.papel === 'limite');
      expect(lim).toMatchObject({ formato: nome, valor: '2026-10-20' });
    },
  );

  it('aviso de lista vazia: zero avisos, NÃO CONFIRMÁVEL', async () => {
    const s = await carregar();
    const analise = s.analisarResposta(
      conteudoDe(resposta([], '<ns2:mensagem>Nenhum aviso.</ns2:mensagem>')),
    );
    expect(analise.avisos).toHaveLength(0);
    const r = s.resumir(s.montarTabela({ ...analise, acompanhados: null }), {
      esperado: 10,
    });
    expect(s.julgar(r)).toMatchObject({ rotulo: 'NÃO CONFIRMÁVEL' });
  });

  it('um único aviso (objeto, não lista) também é lido', async () => {
    const s = await carregar();
    const analise = s.analisarResposta(conteudoDe(resposta([aviso(2, {})])));
    expect(analise.avisos).toHaveLength(1);
    expect(analise.numerosPorAviso[0]).toEqual([
      (NUMEROS[2] as string).replace(/\D/g, ''),
    ]);
  });

  it('desce num invólucro <avisos><aviso>…</aviso></avisos>', async () => {
    const s = await carregar();
    const xml = resposta([
      `<ns2:avisos>${[aviso(0, {}), aviso(1, {})].join('')}</ns2:avisos>`,
    ]);
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
    expect(campos['prazoEmDias']).toMatchObject({ papel: 'prazo' }); // dias não são data limite
    expect(campos['prazoFinal']).toMatchObject({
      papel: 'limite',
      formato: 'dd/MM/AAAA',
    });
  });

  it('data de 14 dígitos inválida (mês 13) não vira data', async () => {
    const s = await carregar();
    expect(s.lerData('20261301093000')).toBeUndefined();
    expect(s.lerData('20261020')?.iso).toBe('2026-10-20');
    expect(s.formatoDe('20261301093000')).toBe('só dígitos (14)');
    expect(s.papelDoCampo('processo/@numero', NUMEROS[0] as string)).toBe('processo');
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
  const resumoDe = async (
    avisos: string[],
    o: { esperado?: number; semLimiteEsperado?: number },
  ): Promise<Resumo> => {
    const s = await carregar();
    const a = s.analisarResposta(conteudoDe(resposta(avisos)));
    return s.resumir(s.montarTabela({ ...a, acompanhados: null }), o);
  };

  it('PARCIAL quando vêm menos avisos que a tela', async () => {
    const s = await carregar();
    expect(
      s.julgar(await resumoDe(dezAvisos().slice(0, 6), { esperado: 10 })),
    ).toMatchObject({ rotulo: 'PARCIAL' });
  });

  it('PARCIAL quando nenhum aviso tem data limite', async () => {
    const s = await carregar();
    const sem = NUMEROS.map((_, i) => aviso(i, { limite: 'ausente' }));
    const j = s.julgar(await resumoDe(sem, { esperado: 10 }));
    expect(j).toMatchObject({ rotulo: 'PARCIAL' });
    expect(j.motivo).toMatch(/data limite/);
  });

  it('PARCIAL quando o número de avisos sem limite difere do Projudi', async () => {
    const s = await carregar();
    const todos = NUMEROS.map((_, i) => aviso(i, {}));
    expect(
      s.julgar(await resumoDe(todos, { esperado: 10, semLimiteEsperado: 2 })),
    ).toMatchObject({ rotulo: 'PARCIAL' });
  });

  it('PARCIAL sem --esperado: sem referência não se afirma completude', async () => {
    const s = await carregar();
    expect(s.julgar(await resumoDe(dezAvisos(), {}))).toMatchObject({
      rotulo: 'PARCIAL',
    });
  });

  it('NÃO CONFIRMÁVEL quando vêm MAIS avisos que a tela (a lista não é a mesma)', async () => {
    const s = await carregar();
    expect(s.julgar(await resumoDe(dezAvisos(), { esperado: 7 }))).toMatchObject({
      rotulo: 'NÃO CONFIRMÁVEL',
    });
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
    expect(texto).not.toMatch(/Fulano|Texto livre|Sintetico/);
    expect(texto).toContain('Citação');
    expect(texto).toContain('2026-10-20');
    expect(texto).toContain('dataLimite');
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
      [`--offline=${arquivo}`, '--esperado=10', '--sem-limite-esperado=2'],
      deps,
      (l) => saida.push(l),
    );
    expect(codigo).toBe(0);
    expect(proibido).not.toHaveBeenCalled();
    const texto = saida.join('\n');
    expect(texto).toContain('avisos recebidos: 10');
    expect(texto).toContain('4 de 10 avisos são de processo acompanhado');
    expect(texto).toMatch(/COMPATÍVEL/);
    expect(texto).toMatch(/não conseguiu medir/);
    expect(texto).not.toMatch(/Fulano|Texto livre/);
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
    expect(texto).toContain('confirmarRecebimento'); // listada como recusada
    expect(texto).toContain('sonda-avisos-pendentes-tabela.json');
  });

  it('o topo do script não importa banco nem dist/ (só os modos reais os carregam)', () => {
    const fonte = readFileSync(CAMINHO, 'utf8');
    const estaticos = fonte.split('\n').filter((l) => /^import /.test(l));
    expect(estaticos.join('\n')).not.toMatch(/node:sqlite|dist\//);
    // e os imports de dist/ e do sqlite acontecem só dentro de dependenciasReais
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
  it('descreve entrada e saída em ordem, os opcionais e a extensão local', async () => {
    const s = await carregar();
    const a = s.analisarWsdl(
      new Map([
        ['w', WSDL({ doc: 'Retorna a lista de avisos pendentes do consultante.' })],
      ]),
    );
    const op = a.operacoes['consultarAvisosPendentes'] as Op;
    expect(op.encontrada).toBe(true);
    expect(op.entrada.namespace).toBe(
      'http://www.cnj.jus.br/servico-intercomunicacao-2.2.2/',
    );
    expect(op.entrada.filhos.map((f) => `${f.nome}:${f.minOccurs}`)).toEqual([
      'idConsultante:1',
      'senhaConsultante:1',
      'idRepresentado:0',
      'dataReferencia:0',
    ]);
    expect(op.saida.filhos.map((f) => f.nome)).toEqual(['sucesso', 'mensagem', 'aviso']);
    expect(op.saida.filhos[2]?.filhos.map((f) => f.nome)).toEqual([
      'processo',
      'dataLimite',
      '@idAviso',
    ]);
    expect(op.soapAction).toMatch(/consultarAvisosPendentes$/);
    const rel = a.operacoes['consultarRelatorioDeIntimacoesTJGO'] as Op;
    expect(rel.entrada.filhos.map((f) => f.nome)).toEqual([
      'idConsultante',
      'senhaConsultante',
      'inicio',
    ]);
    expect(a.proibidasPresentes).toEqual(['confirmarRecebimento']);
  });

  it('autoriza a consulta quando só há opcionais além de id e senha', async () => {
    const s = await carregar();
    const av = s.avaliarWsdl(
      s.analisarWsdl(new Map([['w', WSDL({ doc: 'Retorna a lista de avisos.' })]])),
    );
    expect(av.abortar).toEqual([]);
    expect(av.acao).toBe(s.ACAO_AVISOS);
  });

  it('PARA quando a entrada exige elemento que o envelope não monta', async () => {
    const s = await carregar();
    const av = s.avaliarWsdl(
      s.analisarWsdl(new Map([['w', WSDL({ extraObrigatorio: true })]])),
    );
    expect(av.abortar.join(' ')).toMatch(/codigoNovo/);
  });

  it('PARA quando a ordem de id/senha no WSDL é outra', async () => {
    const s = await carregar();
    const av = s.avaliarWsdl(
      s.analisarWsdl(new Map([['w', WSDL({ ordem: 'trocada' })]])),
    );
    expect(av.abortar.join(' ')).toMatch(/ordem/);
  });

  it('PARA quando a documentação indica efeito colateral; só avisa quando é ambígua', async () => {
    const s = await carregar();
    const forte = s.avaliarWsdl(
      s.analisarWsdl(
        new Map([['w', WSDL({ doc: 'Lista os avisos e marca como lido.' })]]),
      ),
    );
    expect(forte.abortar.join(' ')).toMatch(/efeito colateral/);
    const fraco = s.avaliarWsdl(
      s.analisarWsdl(new Map([['w', WSDL({ doc: 'Avisos pendentes de ciência.' })]])),
    );
    expect(fraco.abortar).toEqual([]);
    expect(fraco.avisos.join(' ')).toMatch(/ciência/);
    expect(
      s.indiciosDeEfeitoColateral('Registra ciência da intimação').fortes.length,
    ).toBeGreaterThan(0);
  });

  it('sem documentação, avisa que a ausência de efeito colateral não está provada', async () => {
    const s = await carregar();
    const av = s.avaliarWsdl(s.analisarWsdl(new Map([['w', WSDL()]])));
    expect(av.avisos.join(' ')).toMatch(/NÃO está provada/);
  });

  it('PARA quando o WSDL não declara a operação', async () => {
    const s = await carregar();
    const av = s.avaliarWsdl(
      s.analisarWsdl(
        new Map([['w', WSDL().replaceAll('consultarAvisosPendentes', 'outraCoisa')]]),
      ),
    );
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

  function montarDeps(o: { wsdl: string; resposta?: string; falha?: Error }): {
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
        baixarDocumento: async () => o.wsdl,
        consultarAvisos: consultar,
      },
    };
  }

  it('consulta UMA vez, grava a tabela sem dado pessoal e não imprime número, nome ou texto', async () => {
    const s = await carregar();
    const { deps, gravados, consultar } = montarDeps({
      wsdl: WSDL({ doc: 'Lista os avisos.' }),
      resposta: resposta(dezAvisos()),
    });
    const saida: string[] = [];
    const codigo = await s.principal(
      ['--esperado=10', '--sem-limite-esperado=2'],
      deps,
      (l) => saida.push(l),
    );
    expect(codigo).toBe(0);
    expect(consultar).toHaveBeenCalledTimes(1);
    const texto = saida.join('\n');
    expect(texto).toContain('3 de 10 avisos são de processo acompanhado');
    expect(texto).toContain('COMPATÍVEL');
    expect(texto).toContain('*******-**.****.8.09.****');
    for (const n of NUMEROS) expect(texto).not.toContain(n);
    expect(texto).not.toMatch(/Fulano|Texto livre|\d{2}\/\d{2}\/2026/);

    const [caminho, conteudo] = [...gravados.entries()][0] ?? ['', ''];
    expect(caminho).toBe('/tmp/sonda-spec/sonda-avisos-pendentes-tabela.json');
    for (const n of NUMEROS) expect(conteudo).not.toContain(n.replace(/\D/g, ''));
    expect(JSON.parse(conteudo as string).acompanhados).toEqual({
      avisosComProcesso: 10,
      acompanhados: 3,
      totalCarteira: 3,
    });
  });

  it('com --mostrar imprime número e datas no terminal, e ainda não grava no arquivo', async () => {
    const s = await carregar();
    const { deps, gravados } = montarDeps({
      wsdl: WSDL({ doc: 'Lista os avisos.' }),
      resposta: resposta(dezAvisos()),
    });
    const saida: string[] = [];
    await s.principal(['--mostrar', '--esperado=10'], deps, (l) => saida.push(l));
    const texto = saida.join('\n');
    expect(texto).toContain(NUMEROS[0]);
    expect(texto).toMatch(/publicação 01\/10\/2026/);
    expect([...gravados.values()].join('')).not.toContain('2026-10-20T');
    expect([...gravados.values()].join('')).not.toContain(NUMEROS[0]);
  });

  it('não toca na credencial quando o WSDL não autoriza', async () => {
    const s = await carregar();
    const { deps, consultar } = montarDeps({ wsdl: WSDL({ doc: 'Marca como lido.' }) });
    const codigo = await s.principal([], deps, () => undefined);
    expect(codigo).toBe(2);
    expect(consultar).not.toHaveBeenCalled();
  });

  it('aborta (código 2) quando o tribunal falha, sem segunda tentativa', async () => {
    const s = await carregar();
    const { deps, consultar } = montarDeps({
      wsdl: WSDL({ doc: 'Lista os avisos.' }),
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
  it('é a 1.0.0', async () => {
    expect((await carregar()).VERSAO_SONDA).toBe('1.0.0');
  });
});
