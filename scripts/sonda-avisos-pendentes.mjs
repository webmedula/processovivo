#!/usr/bin/env node
/**
 * SONDA DOS AVISOS PENDENTES — v1.0.0
 *
 * UMA pergunta: a operação MNI `consultarAvisosPendentes` devolve a mesma lista
 * que o advogado vê no Projudi em Pendências → "Intimações/Citações publicadas no
 * Diário Eletrônico" (processo, movimentação, data de publicação e "Possível Data
 * Limite")? Se devolver, a lista vira a fonte oficial de "prazo em aberto" do
 * Processo Vivo: o sistema não calcula prazo, CITA o que o tribunal informa.
 *
 * Mede, numa única consulta real:
 *  1. a estrutura da operação no WSDL (entrada e saída, em ordem) e a de
 *     `consultarRelatorioDeIntimacoesTJGO` (extensão local — só descrita, NUNCA
 *     chamada);
 *  2. quantos avisos vieram, que campos cada um traz (nome e FORMATO, nunca o
 *     valor), quais datas existem, se há campo equivalente a "Possível Data
 *     Limite" e em quantos avisos vem vazio, a distribuição por tipo de
 *     comunicação e quantos avisos são de processos acompanhados do workspace;
 *  3. com `--mostrar`, número, publicação e data limite de cada aviso — SÓ no
 *     terminal — para o dono conferir com a tela do Projudi;
 *  4. uma tabela numérica em `os.tmpdir()` (sem número de processo, sem texto,
 *     sem nome) que o modo `--offline` relê;
 *  5. um julgamento: COMPATÍVEL, PARCIAL ou NÃO CONFIRMÁVEL, e o que não foi
 *     possível medir.
 *
 * REGRAS DE SEGURANÇA (inegociáveis; iguais às das sondas anteriores e mais duras)
 *  - SÓ `consultarAvisosPendentes`. `confirmarRecebimento`,
 *    `consultarTeorComunicacao` e `entregarManifestacaoProcessual` são recusados
 *    POR CONSTRUÇÃO (lista de bloqueio + lista de permissão, `garantirOperacao
 *    Permitida`, com teste): confirmar recebimento ou abrir o teor pode contar
 *    como CIÊNCIA e abrir prazo para o advogado. A guarda roda sobre o envelope e
 *    sobre o SOAPAction ANTES de qualquer byte sair.
 *  - UMA consulta, sem repetição, pelo `MniAdapter` (limitador único, disjuntor
 *    de 403, classificação de recusa, decifragem pelo cofre). Tentativa
 *    malsucedida conta para o bloqueio da conta do advogado.
 *  - Banco em `readOnly`; `--workspace` obrigatório com mais de uma credencial;
 *    recusa-se a rodar sobre credencial já marcada como recusada.
 *  - Aborta em HTTP 403, 429, 5xx, `sucesso: false`, timeout ou resposta fora do
 *    contrato, e diz o motivo.
 *  - Senha, XML cru e CONTEÚDO (descrição, teor, partes) nunca vão para stdout,
 *    stderr, log nem arquivo. Sem `--mostrar`, os números de processo saem
 *    mascarados; com `--mostrar` saem só no terminal.
 *  - ANTES de abrir a credencial, a sonda baixa o WSDL (GET sem credencial) e
 *    confere a operação: se faltar, se pedir elemento obrigatório que o envelope
 *    não sabe montar, ou se a documentação indicar efeito colateral (marcar como
 *    lido, registrar ciência, abrir prazo), PARA sem consultar.
 *
 * Uso:
 *   node scripts/sonda-avisos-pendentes.mjs --wsdl                  # só o WSDL (sem credencial)
 *   node scripts/sonda-avisos-pendentes.mjs --wsdl-arquivo=<wsdl.xml>
 *   node scripts/sonda-avisos-pendentes.mjs --seco                  # mostra o envelope (sem senha)
 *   node scripts/sonda-avisos-pendentes.mjs [--workspace=<nome>] [--esperado=10] \
 *        [--sem-limite-esperado=2] [--mostrar] [--tribunal=TJGO]    # a consulta real
 *   node scripts/sonda-avisos-pendentes.mjs --offline=<tabela.json> [--esperado=10]
 *
 *   --seco     não abre banco nem rede: só o plano e o envelope.
 *   --offline  analisa a tabela já gravada: sem banco, sem tribunal, sem dist/.
 *
 * A consulta real requer `npm run build` antes (importa de `dist/`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

export const VERSAO_SONDA = '1.0.0';
export const OPERACAO = 'consultarAvisosPendentes';
export const OPERACAO_RELATORIO_LOCAL = 'consultarRelatorioDeIntimacoesTJGO';
/**
 * Operações que a sonda NUNCA monta nem envia. Além desta lista há a de permissão
 * (só `OPERACAO` passa): a de bloqueio existe para o erro dizer POR QUE recusou, e
 * para o teste fixar os três nomes que importam.
 */
export const OPERACOES_PROIBIDAS = Object.freeze([
  'confirmarRecebimento',
  'consultarTeorComunicacao',
  'entregarManifestacaoProcessual',
]);

const NS_SERVICO = 'http://www.cnj.jus.br/servico-intercomunicacao-2.2.2/';
const NS_TIPOS = 'http://www.cnj.jus.br/tipos-servico-intercomunicacao-2.2.2';
export const ACAO_AVISOS = `${NS_SERVICO}${OPERACAO}`;
export const WSDL_PADRAO = 'https://projudi.tjgo.jus.br/IntercomunicacaoService?WSDL';
export const NOME_TABELA = 'sonda-avisos-pendentes-tabela.json';

const MAX_DOCUMENTOS_WSDL = 8;
const PROFUNDIDADE_SAIDA = 6;
const OMITIDO = '(omitido)';

// =============================================================================
// Erros
// =============================================================================
export class OperacaoProibidaError extends Error {
  constructor(operacao, motivo) {
    super(`Operação "${operacao}" recusada: ${motivo}`);
    this.name = 'OperacaoProibidaError';
  }
}

/** A sonda parou de propósito. A mensagem pode ser impressa; nunca leva segredo. */
export class SondaAbortada extends Error {
  constructor(motivo) {
    super(motivo);
    this.name = 'SondaAbortada';
  }
}

// =============================================================================
// Guarda das operações
// =============================================================================
const semPrefixo = (nome) => String(nome ?? '').split(/[:/#]/).pop() ?? '';

export function garantirOperacaoPermitida(operacao) {
  const nome = semPrefixo(operacao);
  const proibida = OPERACOES_PROIBIDAS.find((p) => p.toLowerCase() === nome.toLowerCase());
  if (proibida) {
    throw new OperacaoProibidaError(
      proibida,
      'pode contar como ciência e abrir prazo para o advogado. A sonda só consulta a lista.',
    );
  }
  if (nome !== OPERACAO) {
    throw new OperacaoProibidaError(
      nome || '(vazia)',
      `a sonda só executa ${OPERACAO}.`,
    );
  }
}

/**
 * Última barreira antes de a requisição sair: o corpo do envelope e o SOAPAction
 * têm de ser da mesma operação permitida, e nenhum nome proibido pode aparecer em
 * lugar nenhum do texto (uma operação escondida num elemento filho, por exemplo).
 */
export function validarEnvelopeEAcao(xml, acao) {
  const m = /<soapenv:Body>\s*<srv:([A-Za-z0-9_]+)[\s>]/.exec(xml);
  garantirOperacaoPermitida(m?.[1]);
  garantirOperacaoPermitida(acao);
  if (semPrefixo(acao) !== m?.[1]) {
    throw new OperacaoProibidaError(semPrefixo(acao), 'o SOAPAction não bate com o corpo.');
  }
  for (const p of OPERACOES_PROIBIDAS) {
    if (xml.toLowerCase().includes(p.toLowerCase()) || acao.toLowerCase().includes(p.toLowerCase())) {
      throw new OperacaoProibidaError(p, 'o nome aparece dentro do envelope.');
    }
  }
}

// =============================================================================
// Envelope
// =============================================================================
const escaparXml = (v) =>
  String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * O envelope mínimo: só os dois elementos obrigatórios, NESTA ordem (o tipo é
 * `xs:sequence`). Os opcionais (representado, data de referência) ficam de fora de
 * propósito — sem eles o tribunal devolve o padrão, que é o que a tela do Projudi
 * mostra. Mesmos namespaces do restante do MNI (`mni.envelope.ts`).
 */
export function envelopeAvisosPendentes({ identificacao, senha }) {
  const el = (n, v) => `<tip:${n}>${escaparXml(v)}</tip:${n}>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"` +
    ` xmlns:srv="${NS_SERVICO}" xmlns:tip="${NS_TIPOS}">` +
    `<soapenv:Body><srv:${OPERACAO}>` +
    el('idConsultante', identificacao) +
    el('senhaConsultante', senha) +
    `</srv:${OPERACAO}></soapenv:Body></soapenv:Envelope>`
  );
}

/** O que o `--seco` mostra: o envelope inteiro, sem identificação e sem senha. */
export const envelopeParaExibir = () =>
  envelopeAvisosPendentes({ identificacao: OMITIDO, senha: OMITIDO });

// =============================================================================
// Leitura da árvore do fast-xml-parser (mesmas convenções do mapper do MNI)
// =============================================================================
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

const registro = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
const lista = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const semAcento = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function textoDe(no) {
  if (typeof no === 'string') return no;
  if (typeof no === 'number' || typeof no === 'boolean') return String(no);
  const t = registro(no)?.['#text'];
  return t === undefined ? undefined : String(t);
}

// =============================================================================
// 1. WSDL
// =============================================================================
const local = (s) => (typeof s === 'string' ? s.split(':').pop() : undefined);

/** Referências a outros documentos (xs:import/xs:include, wsdl:import). */
export function referenciasExternas(xml) {
  const arvore = registro(parser.parse(xml)) ?? {};
  const defs = registro(arvore['definitions']);
  const esquemas = [];
  for (const t of lista(defs?.['types'])) esquemas.push(...lista(registro(t)?.['schema']));
  esquemas.push(...lista(arvore['schema']));
  const saida = [];
  for (const s of esquemas) {
    for (const k of ['import', 'include']) {
      for (const i of lista(registro(s)?.[k])) {
        const loc = registro(i)?.['@_schemaLocation'];
        if (loc) saida.push(loc);
      }
    }
  }
  for (const i of lista(defs?.['import'])) {
    const loc = registro(i)?.['@_location'];
    if (loc) saida.push(loc);
  }
  return saida;
}

/**
 * Baixa o WSDL e os documentos que ele importa. Só GET, só o mesmo host, no máximo
 * `MAX_DOCUMENTOS_WSDL` — a sonda não é um rastreador.
 */
export async function baixarWsdlCompleto(baixar, urlRaiz) {
  const raiz = new URL(urlRaiz);
  const documentos = new Map();
  const fila = [urlRaiz];
  while (fila.length > 0 && documentos.size < MAX_DOCUMENTOS_WSDL) {
    const url = fila.shift();
    if (documentos.has(url)) continue;
    const xml = await baixar(url);
    documentos.set(url, xml);
    let refs = [];
    try {
      refs = referenciasExternas(xml);
    } catch {
      continue; // documento ilegível entra na análise, que reclama dele
    }
    for (const r of refs) {
      let alvo;
      try {
        alvo = new URL(r, url);
      } catch {
        continue;
      }
      if (alvo.host !== raiz.host || alvo.protocol !== raiz.protocol) continue;
      if (!documentos.has(alvo.href) && !fila.includes(alvo.href)) fila.push(alvo.href);
    }
  }
  return documentos;
}

function indexarDocumento(arvore, indice) {
  const defs = registro(arvore['definitions']);
  const esquemas = [];
  for (const t of lista(defs?.['types'])) esquemas.push(...lista(registro(t)?.['schema']));
  esquemas.push(...lista(arvore['schema']));
  for (const s of esquemas) {
    const esq = registro(s);
    if (!esq) continue;
    const alvo = esq['@_targetNamespace'];
    for (const el of lista(esq['element'])) {
      const nome = registro(el)?.['@_name'];
      if (nome) indice.elementos.set(nome, { no: el, alvo });
    }
    for (const ct of lista(esq['complexType'])) {
      const nome = registro(ct)?.['@_name'];
      if (nome) indice.tipos.set(nome, { no: ct, alvo });
    }
  }
  if (!defs) return;
  for (const m of lista(defs['message'])) {
    const nome = registro(m)?.['@_name'];
    if (!nome) continue;
    indice.mensagens.set(
      nome,
      lista(registro(m)?.['part']).map((p) => ({
        nome: registro(p)?.['@_name'],
        elemento: local(registro(p)?.['@_element']),
        tipo: local(registro(p)?.['@_type']),
      })),
    );
  }
  for (const pt of lista(defs['portType'])) {
    for (const op of lista(registro(pt)?.['operation'])) {
      const o = registro(op);
      const nome = o?.['@_name'];
      if (!nome) continue;
      indice.operacoes.set(nome, {
        documentacao: textoDe(o['documentation']),
        entrada: local(registro(o['input'])?.['@_message']),
        saida: local(registro(o['output'])?.['@_message']),
      });
    }
  }
  for (const b of lista(defs['binding'])) {
    for (const op of lista(registro(b)?.['operation'])) {
      const nome = registro(op)?.['@_name'];
      const acao = registro(registro(op)?.['operation'])?.['@_soapAction'];
      if (nome && acao !== undefined) indice.soapActions.set(nome, acao);
    }
  }
}

function filhosDeGrupo(grupo, emChoice, saida, ctx) {
  const g = registro(grupo);
  if (!g) return;
  for (const el of lista(g['element'])) saida.push({ no: el, emChoice });
  for (const k of ['sequence', 'all']) {
    for (const s of lista(g[k])) filhosDeGrupo(s, emChoice, saida, ctx);
  }
  for (const c of lista(g['choice'])) filhosDeGrupo(c, true, saida, ctx);
}

function filhosDoTipo(ct, indice, prof, vistos) {
  const saida = [];
  let corpo = registro(ct);
  if (!corpo) return saida;
  const ext = registro(registro(corpo['complexContent'])?.['extension']);
  if (ext) {
    const base = indice.tipos.get(local(ext['@_base']) ?? '')?.no;
    if (base) saida.push(...filhosDoTipo(base, indice, prof, vistos));
    corpo = ext;
  }
  const brutos = [];
  filhosDeGrupo(corpo, false, brutos);
  for (const { no, emChoice } of brutos) saida.push(descreverElemento(no, indice, prof, vistos, emChoice));
  for (const a of lista(corpo['attribute'])) {
    const at = registro(a);
    if (!at) continue;
    saida.push({
      nome: `@${at['@_name'] ?? local(at['@_ref']) ?? '?'}`,
      tipo: local(at['@_type']) ?? 'string',
      minOccurs: at['@_use'] === 'required' ? '1' : '0',
      maxOccurs: '1',
      atributo: true,
      emChoice: false,
      filhos: [],
    });
  }
  return saida;
}

function descreverElemento(no, indice, prof, vistos, emChoice = false) {
  let el = registro(no) ?? {};
  const ref = local(el['@_ref']);
  if (ref) el = { ...registro(indice.elementos.get(ref)?.no), ...el, '@_name': ref };
  const tipoRef = local(el['@_type']);
  const ct = registro(el['complexType']) ?? (tipoRef ? indice.tipos.get(tipoRef)?.no : undefined);
  const descendo = ct && prof > 0 && !(tipoRef && vistos.has(tipoRef));
  const filhos = descendo
    ? filhosDoTipo(ct, indice, prof - 1, tipoRef ? new Set([...vistos, tipoRef]) : vistos)
    : [];
  const doc = textoDe(registro(registro(el['annotation'])?.['documentation']) ?? el['annotation']);
  return {
    nome: el['@_name'] ?? '?',
    tipo: tipoRef ?? (ct ? '(estrutura)' : 'string'),
    minOccurs: el['@_minOccurs'] ?? '1',
    maxOccurs: el['@_maxOccurs'] ?? '1',
    atributo: false,
    emChoice,
    ...(doc ? { doc: doc.slice(0, 160) } : {}),
    filhos,
  };
}

function descreverMensagem(nomeMensagem, indice, prof) {
  const partes = indice.mensagens.get(nomeMensagem ?? '') ?? [];
  const primeira = partes[0];
  if (primeira?.elemento) {
    const achado = indice.elementos.get(primeira.elemento);
    if (!achado) return { elemento: primeira.elemento, namespace: undefined, filhos: [], semDefinicao: true };
    const d = descreverElemento(achado.no, indice, prof, new Set());
    return { elemento: d.nome, namespace: achado.alvo, filhos: d.filhos };
  }
  return {
    elemento: nomeMensagem ?? '?',
    namespace: undefined,
    filhos: partes.map((p) => ({
      nome: p.nome ?? '?',
      tipo: p.tipo ?? 'string',
      minOccurs: '1',
      maxOccurs: '1',
      atributo: false,
      emChoice: false,
      filhos: [],
    })),
  };
}

export function analisarWsdl(documentos, operacoes = [OPERACAO, OPERACAO_RELATORIO_LOCAL]) {
  const indice = {
    elementos: new Map(),
    tipos: new Map(),
    mensagens: new Map(),
    operacoes: new Map(),
    soapActions: new Map(),
  };
  let lidos = 0;
  for (const xml of documentos.values()) {
    let arvore;
    try {
      arvore = registro(parser.parse(xml));
    } catch {
      continue;
    }
    if (!arvore) continue;
    lidos += 1;
    indexarDocumento(arvore, indice);
  }
  const resultado = {};
  for (const nome of operacoes) {
    const op = indice.operacoes.get(nome);
    if (!op) {
      resultado[nome] = { encontrada: false };
      continue;
    }
    resultado[nome] = {
      encontrada: true,
      ...(op.documentacao ? { documentacao: op.documentacao } : {}),
      ...(indice.soapActions.has(nome) ? { soapAction: indice.soapActions.get(nome) } : {}),
      entrada: descreverMensagem(op.entrada, indice, 2),
      saida: descreverMensagem(op.saida, indice, PROFUNDIDADE_SAIDA),
    };
  }
  const todas = [...indice.operacoes.keys()];
  return {
    documentosLidos: lidos,
    operacoesDoServico: todas,
    proibidasPresentes: OPERACOES_PROIBIDAS.filter((p) => todas.includes(p)),
    operacoes: resultado,
  };
}

/** Expressões que, na documentação da operação, indicam efeito colateral. */
const INDICIOS_FORTES = [
  /marc[a-z]* (como )?(lid|ciente|visualizad)/,
  /registr[a-z]* (a )?ciencia/,
  /(abre|abrem|inicia|iniciam|dispara|disparam)[a-z]* (o |os )?prazo/,
  /(da|dar|dando|gera|geram) ciencia/,
  /confirm[a-z]* (o )?recebimento/,
  /considera[a-z]* (a )?(parte )?(intimad|cient)/,
];
const INDICIOS_FRACOS = [/ciencia/, /\blid[oa]s?\b/, /confirm/, /baixa/, /marc[ao]/];

export function indiciosDeEfeitoColateral(documentacao) {
  const t = semAcento(documentacao ?? '');
  return {
    fortes: INDICIOS_FORTES.filter((r) => r.test(t)).map((r) => r.source),
    fracos: INDICIOS_FRACOS.filter((r) => r.test(t)).map((r) => r.source),
  };
}

/**
 * Pré-condição da consulta real. `abortar` não vazio = a sonda PARA, sem tocar na
 * credencial. `avisos` só informam.
 */
export function avaliarWsdl(analise) {
  const abortar = [];
  const avisos = [];
  const op = analise.operacoes[OPERACAO];
  if (!op?.encontrada) {
    abortar.push(`o WSDL não declara a operação ${OPERACAO}`);
    return { abortar, avisos, acao: ACAO_AVISOS };
  }
  const entrada = op.entrada;
  const filhos = entrada.filhos.filter((f) => !f.atributo);
  const nomes = filhos.map((f) => f.nome);
  const pos = (n) => nomes.indexOf(n);
  for (const n of ['idConsultante', 'senhaConsultante']) {
    if (pos(n) < 0) abortar.push(`a entrada não tem ${n}; o envelope da sonda não saberia montá-la`);
  }
  if (pos('idConsultante') >= 0 && pos('senhaConsultante') >= 0 && pos('idConsultante') > pos('senhaConsultante')) {
    abortar.push('a ordem de idConsultante/senhaConsultante no WSDL é outra (xs:sequence)');
  }
  const desconhecidosObrigatorios = filhos
    .filter((f) => f.minOccurs !== '0' && !f.emChoice)
    .map((f) => f.nome)
    .filter((n) => n !== 'idConsultante' && n !== 'senhaConsultante');
  if (desconhecidosObrigatorios.length > 0) {
    abortar.push(
      `a entrada exige elemento(s) que o envelope não monta: ${desconhecidosObrigatorios.join(', ')}`,
    );
  }
  if (entrada.namespace !== undefined && entrada.namespace !== NS_SERVICO) {
    abortar.push(`o elemento de entrada está em outro namespace (${entrada.namespace})`);
  }
  const ind = indiciosDeEfeitoColateral(op.documentacao);
  if (ind.fortes.length > 0) {
    abortar.push('a documentação da operação indica efeito colateral (ciência/prazo/marcação)');
  } else if (ind.fracos.length > 0) {
    avisos.push('a documentação cita termos de ciência/leitura: leia o texto antes de autorizar');
  }
  if (!op.documentacao) {
    avisos.push('o WSDL não traz documentação da operação: a ausência de efeito colateral NÃO está provada por ele');
  }
  if (analise.proibidasPresentes.length > 0) {
    avisos.push(`o serviço também declara (e a sonda recusa): ${analise.proibidasPresentes.join(', ')}`);
  }
  const acaoDoWsdl = op.soapAction ? String(op.soapAction) : undefined;
  let acao = ACAO_AVISOS;
  if (acaoDoWsdl && acaoDoWsdl !== ACAO_AVISOS) {
    if (semPrefixo(acaoDoWsdl) === OPERACAO) {
      acao = acaoDoWsdl;
      avisos.push('o SOAPAction do WSDL difere do padrão; a sonda usa o do WSDL');
    } else {
      abortar.push('o SOAPAction declarado no WSDL não é o da operação');
    }
  }
  return { abortar, avisos, acao };
}

function arvoreTexto(filhos, nivel = 1, saida = []) {
  for (const f of filhos) {
    const card = `${f.minOccurs}..${f.maxOccurs === 'unbounded' ? 'n' : f.maxOccurs}`;
    saida.push(
      `${'  '.repeat(nivel)}${f.nome} : ${f.tipo} [${card}]${f.emChoice ? ' (escolha)' : ''}` +
        (f.doc ? `  — ${f.doc}` : ''),
    );
    arvoreTexto(f.filhos, nivel + 1, saida);
  }
  return saida;
}

export function imprimirWsdl(analise, escrever = console.log) {
  escrever('== 1. WSDL ==');
  escrever(`documentos lidos: ${analise.documentosLidos} · operações do serviço: ${analise.operacoesDoServico.length}`);
  for (const [nome, op] of Object.entries(analise.operacoes)) {
    escrever(`\n-- ${nome}${nome === OPERACAO_RELATORIO_LOCAL ? ' (extensão local; só descrita, nunca chamada)' : ''}`);
    if (!op.encontrada) {
      escrever('   não declarada neste WSDL.');
      continue;
    }
    escrever(`   SOAPAction: ${op.soapAction ?? '(não declarado)'}`);
    escrever(`   documentação: ${op.documentacao ? op.documentacao.replace(/\s+/g, ' ').slice(0, 400) : '(nenhuma)'}`);
    escrever(`   entrada <${op.entrada.elemento}> ns=${op.entrada.namespace ?? '?'} (ordem do xs:sequence):`);
    for (const l of arvoreTexto(op.entrada.filhos, 2)) escrever(l);
    escrever(`   saída <${op.saida.elemento}> (em ordem):`);
    for (const l of arvoreTexto(op.saida.filhos, 2)) escrever(l);
  }
  if (analise.proibidasPresentes.length > 0) {
    escrever(`\noperações que a sonda RECUSA e o serviço declara: ${analise.proibidasPresentes.join(', ')}`);
  }
}

// =============================================================================
// 2. Resposta: formatos, papéis, avisos
// =============================================================================
const RE_CNJ = /^\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}$/;

/** Classifica uma data pelo FORMATO e devolve o dia normalizado (AAAA-MM-DD). */
export function lerData(valor) {
  const v = String(valor ?? '').trim();
  const dia = (a, m, d) => {
    const ok = a >= 1990 && a <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
    return ok ? `${String(a).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : undefined;
  };
  let m;
  if ((m = /^(\d{4})(\d{2})(\d{2})(\d{6})$/.exec(v))) {
    const iso = dia(+m[1], +m[2], +m[3]);
    return iso ? { formato: 'AAAAMMDDhhmmss', iso } : undefined;
  }
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(v))) {
    const iso = dia(+m[1], +m[2], +m[3]);
    return iso ? { formato: 'AAAAMMDD', iso } : undefined;
  }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v))) {
    const iso = dia(+m[1], +m[2], +m[3]);
    return iso ? { formato: m[4] ? 'ISO com hora' : 'ISO', iso } : undefined;
  }
  if ((m = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2}))?/.exec(v))) {
    const iso = dia(+m[3], +m[2], +m[1]);
    return iso ? { formato: m[4] ? 'dd/MM/AAAA hh:mm' : 'dd/MM/AAAA', iso } : undefined;
  }
  return undefined;
}

/** Formato do valor, SEM revelar o valor. */
export function formatoDe(valor) {
  const v = String(valor ?? '').trim();
  if (v === '') return 'vazio';
  if (RE_CNJ.test(v)) return 'número CNJ';
  const d = lerData(v);
  if (d) return d.formato;
  if (/^\d+$/.test(v)) return `só dígitos (${v.length})`;
  if (/^(true|false)$/i.test(v)) return 'booleano';
  return v.length <= 40 ? 'texto curto' : 'texto longo';
}

const ehNumeroCnj = (v) => RE_CNJ.test(String(v ?? '').trim());
const soDigitos = (v) => String(v).replace(/\D/g, '');

/** Mostra o tribunal (J.TR), que não identifica ninguém, e apaga o resto. */
export function mascararNumeroProcesso(texto) {
  const v = String(texto ?? '').trim();
  if (RE_CNJ.test(v)) {
    const d = soDigitos(v);
    return `*******-**.****.${d[13]}.${d.slice(14, 16)}.****`;
  }
  return v.replace(/[0-9A-Za-z]/g, '*');
}

export function formatarNumeroCnj(digitos) {
  const d = soDigitos(digitos);
  if (d.length !== 20) return String(digitos);
  return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d[13]}.${d.slice(14, 16)}.${d.slice(16)}`;
}

const dataBr = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');

/**
 * Papel de um campo, decidido pelo NOME (e, para número de processo, pelo valor).
 * Heurística de leitura, não afirmação: o resultado da sonda diz o nome do campo
 * que levou à conclusão, para o dono poder discordar.
 */
export function papelDoCampo(caminho, valor) {
  if (ehNumeroCnj(valor)) return 'processo';
  const folha = semAcento(String(caminho).split('/').pop() ?? '').replace(/[^a-z0-9]/g, '');
  if (/limite|vencimento|datafinal|datafim|terminoprazo|dataprazo|prazofinal|fimprazo/.test(folha)) {
    return 'limite';
  }
  if (/prazo/.test(folha)) {
    const v = String(valor ?? '').trim();
    return v === '' || lerData(v) ? 'limite' : 'prazo';
  }
  if (/disponibiliz|publica|disposic/.test(folha)) return 'publicacao';
  if (/ciencia|^lid[oa]$|recebimento|visualiz|leitura/.test(folha)) return 'ciencia';
  if (/tipocomunic|^tipo$|tipoaviso|^categoria$|modalidade|^natureza$/.test(folha)) return 'tipoComunicacao';
  if (/^(id|identificador|codigo|sequencial)(aviso|comunicacao|intimacao)?$/.test(folha)) return 'identificador';
  if (/destinat|^parte|pessoa|advogado|representad|^nome|^cpf|^cnpj|^oab/.test(folha)) return 'destinatario';
  if (/descri|movimento|teor|assunto|titulo|^texto|^ato$|complemento|observ/.test(folha)) return 'descricao';
  if (lerData(valor)) return 'outraData';
  return 'outro';
}

const PAPEIS_DE_DATA = new Set(['limite', 'publicacao', 'outraData']);
const PROFUNDIDADE_AVISO = 5;

/** Achata um aviso em folhas {caminho, valor}. Atributos entram como `@nome`. */
export function achatarAviso(no, prefixo = '', prof = 0, saida = []) {
  const reg = registro(no);
  if (!reg) {
    if (prefixo) saida.push({ caminho: prefixo, valor: String(no ?? '') });
    return saida;
  }
  for (const [k, v] of Object.entries(reg)) {
    if (k === '#text') {
      saida.push({ caminho: prefixo || '(texto)', valor: String(v) });
      continue;
    }
    const nome = k.startsWith('@_') ? `@${k.slice(2)}` : k;
    const caminho = prefixo ? `${prefixo}/${nome}` : nome;
    for (const item of lista(v)) {
      if (registro(item)) {
        if (prof + 1 >= PROFUNDIDADE_AVISO) saida.push({ caminho, valor: '(estrutura profunda)' });
        else achatarAviso(item, caminho, prof + 1, saida);
      } else {
        saida.push({ caminho, valor: String(item ?? '') });
      }
    }
  }
  return saida;
}

/** Acha a lista de avisos dentro do corpo da resposta. */
export function localizarAvisos(conteudo) {
  let corpo = registro(conteudo) ?? {};
  let chave;
  for (let nivel = 0; nivel < 3; nivel += 1) {
    const candidatos = Object.entries(corpo)
      .filter(([k]) => !['sucesso', 'mensagem'].includes(k) && !k.startsWith('@_'))
      .map(([k, v]) => [k, lista(v).filter((x) => registro(x) !== undefined)])
      .filter(([, itens]) => itens.length > 0);
    if (candidatos.length === 0) return { chave, itens: [] };
    const preferido =
      candidatos.find(([k]) => /aviso|comunicac|intima|citac/i.test(k)) ??
      [...candidatos].sort((a, b) => b[1].length - a[1].length)[0];
    const [k, itens] = preferido;
    chave = chave ? `${chave}/${k}` : k;
    // Um invólucro (`avisos` com um só filho que é a lista de verdade): desce.
    const unico = itens.length === 1 ? registro(itens[0]) : undefined;
    const filhosUnicos = unico
      ? Object.entries(unico).filter(([kk, vv]) => !kk.startsWith('@_') && lista(vv).some((x) => registro(x)))
      : [];
    const soTemLista = unico && filhosUnicos.length >= 1 && Object.keys(unico).every((kk) => !kk.startsWith('@_') && lista(unico[kk]).some((x) => registro(x)));
    if (soTemLista && /aviso|comunicac|intima|citac/i.test(filhosUnicos[0][0])) {
      corpo = unico;
      continue;
    }
    return { chave, itens };
  }
  return { chave, itens: [] };
}

/**
 * Um aviso → { tabela, numeros }. `tabela` é o que pode ser gravado (nomes,
 * formatos, tipo, datas); `numeros` fica só em memória.
 */
export function analisarAviso(no, indice) {
  const folhas = achatarAviso(no);
  const campos = new Map();
  const datas = [];
  const numeros = [];
  let tipoComunicacao = null;
  for (const { caminho, valor } of folhas) {
    const papel = papelDoCampo(caminho, valor);
    const formato = formatoDe(valor);
    const chave = `${caminho}|${formato}|${papel}`;
    if (!campos.has(chave)) campos.set(chave, { nome: caminho, formato, papel });
    if (papel === 'processo') numeros.push(soDigitos(valor));
    if (PAPEIS_DE_DATA.has(papel)) {
      const d = lerData(valor);
      datas.push({ papel, nome: caminho, formato, valor: d ? d.iso : null });
    }
    if (papel === 'tipoComunicacao' && tipoComunicacao === null) {
      const v = String(valor).trim();
      // Só valor curto e de alfabeto de código/rótulo: texto livre não entra.
      if (v !== '' && v.length <= 40 && /^[\p{L}0-9 _./-]+$/u.test(v)) tipoComunicacao = v;
    }
  }
  return {
    tabela: { indice, campos: [...campos.values()], tipoComunicacao, datas },
    numeros: [...new Set(numeros)],
  };
}

export function analisarResposta(conteudo) {
  const { chave, itens } = localizarAvisos(conteudo);
  const analisados = itens.map((it, i) => analisarAviso(it, i + 1));
  return {
    chaveDaLista: chave ?? null,
    avisos: analisados.map((a) => a.tabela),
    numerosPorAviso: analisados.map((a) => a.numeros),
  };
}

// =============================================================================
// 3. Tabela numérica (a que vai para o disco) e o modo --offline
// =============================================================================
export function montarTabela({ chaveDaLista, avisos, acompanhados }) {
  return {
    versao: VERSAO_SONDA,
    chaveDaLista,
    acompanhados: acompanhados ?? null,
    avisos,
  };
}

/** Recusa tabela malformada e tabela com cara de dado pessoal. */
export function validarTabela(bruta) {
  const t = registro(bruta);
  if (!t || !Array.isArray(t['avisos'])) throw new Error('a tabela não tem a lista "avisos"');
  const texto = JSON.stringify(t);
  if (/\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}/.test(texto)) {
    throw new Error('a tabela contém algo com forma de número de processo; recuse-a');
  }
  for (const a of t['avisos']) {
    const av = registro(a);
    if (!av || !Array.isArray(av['campos']) || !Array.isArray(av['datas'])) {
      throw new Error('aviso da tabela fora do formato');
    }
    for (const c of av['campos']) {
      if (typeof registro(c)?.['nome'] !== 'string') throw new Error('campo da tabela sem nome');
    }
  }
  return t;
}

// =============================================================================
// 4. Resumo e julgamento
// =============================================================================
const dias = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function resumir(tabela, { esperado, semLimiteEsperado } = {}) {
  const avisos = tabela.avisos;
  const total = avisos.length;
  const porCampo = new Map();
  const papeis = {};
  const tipos = {};
  let comLimite = 0;
  let limiteVazio = 0;
  let limiteAusente = 0;
  const camposDeLimite = new Set();
  const formatosDeLimite = new Set();
  const formatosDePublicacao = new Set();
  const intervalos = [];
  let comPublicacao = 0;

  for (const a of avisos) {
    const vistos = new Set();
    const papeisDoAviso = new Set();
    for (const c of a.campos) {
      const k = `${c.nome}`;
      const reg = porCampo.get(k) ?? { nome: c.nome, formatos: new Set(), papel: c.papel, emQuantos: 0 };
      reg.formatos.add(c.formato);
      if (!vistos.has(k)) reg.emQuantos += 1;
      vistos.add(k);
      porCampo.set(k, reg);
      papeisDoAviso.add(c.papel);
    }
    for (const p of papeisDoAviso) papeis[p] = (papeis[p] ?? 0) + 1;
    const t = a.tipoComunicacao ?? '(sem tipo)';
    tipos[t] = (tipos[t] ?? 0) + 1;

    const limites = a.datas.filter((d) => d.papel === 'limite');
    const pubs = a.datas.filter((d) => d.papel === 'publicacao');
    for (const l of limites) {
      camposDeLimite.add(l.nome);
      formatosDeLimite.add(l.formato);
    }
    for (const p of pubs) formatosDePublicacao.add(p.formato);
    const limite = limites.find((l) => l.valor);
    const pub = pubs.find((p) => p.valor);
    if (pub) comPublicacao += 1;
    if (limite) {
      comLimite += 1;
      if (pub) intervalos.push(dias(pub.valor, limite.valor));
    } else if (limites.length > 0) limiteVazio += 1;
    else limiteAusente += 1;
  }

  return {
    total,
    esperado: esperado ?? null,
    semLimiteEsperado: semLimiteEsperado ?? null,
    campos: [...porCampo.values()]
      .map((c) => ({ ...c, formatos: [...c.formatos] }))
      .sort((x, y) => x.nome.localeCompare(y.nome)),
    papeis,
    tipos,
    limite: {
      campoExiste: camposDeLimite.size > 0,
      campos: [...camposDeLimite],
      formatos: [...formatosDeLimite],
      preenchidos: comLimite,
      vazios: limiteVazio,
      ausentes: limiteAusente,
      semLimite: limiteVazio + limiteAusente,
    },
    publicacao: { comData: comPublicacao, formatos: [...formatosDePublicacao] },
    diasPublicacaoAteLimite: intervalos.length
      ? { n: intervalos.length, min: Math.min(...intervalos), max: Math.max(...intervalos) }
      : null,
    acompanhados: tabela.acompanhados ?? null,
    chaveDaLista: tabela.chaveDaLista ?? null,
  };
}

/** O que a sonda NÃO consegue medir, sempre dito, junto do julgamento. */
export function naoMedido(resumo, { wsdlConferido = true } = {}) {
  const itens = [
    'se o MNI devolve só os avisos AINDA NÃO LIDOS/sem ciência: uma consulta não separa "pendente" de "todos"; só a igualdade com a tela (--esperado) sugere que é a mesma lista',
    'se cada data é a MESMA da tela: a igualdade das datas é conferência visual do dono (--mostrar)',
    'se o campo de data limite tem a mesma semântica da "Possível Data Limite" do Projudi (a sonda lê o NOME do campo; não o sentido)',
    'se a lista é estável de uma consulta para outra (houve uma só consulta)',
  ];
  if (!wsdlConferido) itens.unshift('o WSDL: a análise foi feita sem ele');
  if (resumo.acompanhados === null) itens.push('quantos avisos são de processos acompanhados (modo offline: números não são gravados)');
  return itens;
}

export function julgar(resumo) {
  const { total, esperado, semLimiteEsperado, limite } = resumo;
  if (total === 0) {
    return { rotulo: 'NÃO CONFIRMÁVEL', motivo: 'a resposta não trouxe nenhum aviso' };
  }
  if (esperado !== null && total > esperado) {
    return {
      rotulo: 'NÃO CONFIRMÁVEL',
      motivo: `vieram ${total} avisos e a tela tem ${esperado}: a lista do MNI não é a da tela (pode incluir já lidos/outros representados)`,
    };
  }
  if (!limite.campoExiste || limite.preenchidos === 0) {
    return { rotulo: 'PARCIAL', motivo: 'há avisos, mas nenhum campo de data limite preenchido' };
  }
  if (esperado === null) {
    return { rotulo: 'PARCIAL', motivo: 'sem --esperado não há como afirmar que a lista está completa' };
  }
  if (total < esperado) {
    return { rotulo: 'PARCIAL', motivo: `vieram ${total} de ${esperado} avisos: lista parcial` };
  }
  if (semLimiteEsperado !== null && limite.semLimite !== semLimiteEsperado) {
    return {
      rotulo: 'PARCIAL',
      motivo: `${limite.semLimite} avisos sem data limite; o Projudi tem ${semLimiteEsperado}`,
    };
  }
  return {
    rotulo: 'COMPATÍVEL',
    motivo:
      `quantidade igual (${total}) e campo de data limite em ${limite.preenchidos} avisos ` +
      `(${limite.semLimite} sem). Falta a conferência visual dos mesmos avisos pelo dono`,
  };
}

export function imprimirResumo(resumo, escrever = console.log) {
  escrever('\n== 2. RESPOSTA ==');
  escrever(
    `avisos recebidos: ${resumo.total}` +
      (resumo.esperado !== null ? ` · esperado na tela: ${resumo.esperado}` : '') +
      (resumo.chaveDaLista ? ` · elemento da lista: <${resumo.chaveDaLista}>` : ''),
  );
  escrever('\ncampos presentes (nome · formato · papel que a sonda lhe atribuiu · em quantos avisos):');
  for (const c of resumo.campos) {
    escrever(`  ${c.nome} · ${c.formatos.join(' | ')} · ${c.papel} · ${c.emQuantos}/${resumo.total}`);
  }
  escrever('\ndatas:');
  escrever(`  publicação/disponibilização: ${resumo.publicacao.comData}/${resumo.total} com data` +
    (resumo.publicacao.formatos.length ? ` · formato ${resumo.publicacao.formatos.join(' | ')}` : ''));
  const l = resumo.limite;
  escrever(
    l.campoExiste
      ? `  campo equivalente a "Possível Data Limite": SIM (${l.campos.join(', ')}) · formato ${l.formatos.join(' | ')}`
      : '  campo equivalente a "Possível Data Limite": NÃO ENCONTRADO',
  );
  escrever(
    `  com data limite: ${l.preenchidos} · campo presente e vazio: ${l.vazios} · campo ausente: ${l.ausentes}` +
      (resumo.semLimiteEsperado !== null ? ` · esperado sem limite: ${resumo.semLimiteEsperado}` : ''),
  );
  if (resumo.diasPublicacaoAteLimite) {
    const d = resumo.diasPublicacaoAteLimite;
    escrever(`  dias da publicação até a data limite: de ${d.min} a ${d.max} (em ${d.n} avisos)`);
  }
  escrever('\ndistribuição por tipo de comunicação:');
  for (const [k, n] of Object.entries(resumo.tipos).sort((a, b) => b[1] - a[1])) {
    escrever(`  ${k}: ${n}`);
  }
  if (resumo.acompanhados) {
    const a = resumo.acompanhados;
    escrever(
      `\nprocessos acompanhados: ${a.acompanhados} de ${a.avisosComProcesso} avisos são de processo acompanhado ` +
        `(carteira do workspace: ${a.totalCarteira})`,
    );
  } else {
    escrever('\nprocessos acompanhados: não medido neste modo');
  }
}

// =============================================================================
// 5. Conferência com o dono (--mostrar) — só terminal
// =============================================================================
export function linhasDeConferencia(analise, { mostrar }) {
  return analise.avisos.map((a, i) => {
    const numero = analise.numerosPorAviso[i]?.[0];
    const rotuloNumero = numero
      ? mostrar
        ? formatarNumeroCnj(numero)
        : mascararNumeroProcesso(formatarNumeroCnj(numero))
      : '(sem número reconhecido)';
    const pub = a.datas.find((d) => d.papel === 'publicacao')?.valor;
    const lim = a.datas.find((d) => d.papel === 'limite' && d.valor)?.valor;
    const partes = [`aviso ${a.indice}`, `processo ${rotuloNumero}`];
    if (mostrar) {
      partes.push(`publicação ${dataBr(pub)}`, `data limite ${lim ? dataBr(lim) : '— (sem)'}`);
    } else {
      partes.push(`data limite ${lim ? 'presente' : 'ausente'}`);
    }
    return partes.join(' · ');
  });
}

/** Cruza o número de cada aviso com a carteira do workspace — só contagens. */
export function contarAcompanhados(numerosPorAviso, carteira) {
  const comProcesso = numerosPorAviso.filter((n) => n.length > 0);
  const acompanhados = comProcesso.filter((n) => n.some((x) => carteira.has(x)));
  return {
    avisosComProcesso: comProcesso.length,
    acompanhados: acompanhados.length,
    totalCarteira: carteira.size,
  };
}

// =============================================================================
// Execução
// =============================================================================
const ARGS_BOOLEANOS = ['seco', 'mostrar', 'wsdl'];
const ARGS_COM_VALOR = [
  'offline',
  'wsdl-arquivo',
  'wsdl-url',
  'workspace',
  'esperado',
  'sem-limite-esperado',
  'tribunal',
];

export function lerArgumentos(entrada) {
  const args = {};
  for (const a of entrada) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`argumento desconhecido: ${a.slice(0, 40)}`);
    const [, nome, valor] = m;
    if (ARGS_BOOLEANOS.includes(nome) && valor === undefined) args[nome] = true;
    else if (ARGS_COM_VALOR.includes(nome) && valor !== undefined && valor !== '') args[nome] = valor;
    else throw new Error(`argumento inválido: --${nome}`);
  }
  for (const n of ['esperado', 'sem-limite-esperado']) {
    if (args[n] !== undefined && !/^\d{1,4}$/.test(args[n])) throw new Error(`--${n} deve ser um inteiro`);
  }
  const modos = ['seco', 'offline', 'wsdl', 'wsdl-arquivo'].filter((m) => args[m] !== undefined);
  if (modos.length > 1) throw new Error(`modos incompatíveis: ${modos.map((m) => `--${m}`).join(', ')}`);
  return args;
}

const USO =
  'Uso: node scripts/sonda-avisos-pendentes.mjs --wsdl | --wsdl-arquivo=<arq> | --seco | ' +
  '--offline=<tabela.json> [--esperado=N] | [--workspace=<nome>] [--esperado=N] ' +
  '[--sem-limite-esperado=N] [--mostrar] [--tribunal=TJGO]';

/** Dependências reais — importadas só quando o modo precisa delas. */
export function dependenciasReais() {
  return {
    tmpdir: () => tmpdir(),
    lerArquivo: (caminho) => readFileSync(caminho, 'utf8'),
    gravarArquivo: (caminho, texto) => writeFileSync(caminho, texto, { mode: 0o600 }),

    /** Banco (readOnly) e config. NÃO decifra a senha. */
    async carregarContexto({ tribunal, workspace }) {
      const { DatabaseSync } = await import('node:sqlite');
      const { carregarConfig } = await import('../dist/infrastructure/config/env.js');
      const config = carregarConfig(process.env);
      const db = new DatabaseSync(config.banco.caminho, { readOnly: true });
      try {
        const linhas = db
          .prepare('SELECT * FROM credenciais_tribunal WHERE tribunal = ?')
          .all(tribunal);
        const candidatas = workspace ? linhas.filter((l) => l.workspace === workspace) : linhas;
        if (linhas.length === 0) throw new SondaAbortada(`Nenhuma credencial cadastrada para ${tribunal}.`);
        if (candidatas.length === 0) {
          throw new SondaAbortada(`Nenhuma credencial de ${tribunal} no workspace "${workspace}".`);
        }
        if (candidatas.length > 1) {
          throw new SondaAbortada(
            `Há ${candidatas.length} credenciais de ${tribunal}. Escolha com --workspace=<nome>:\n` +
              candidatas.map((l) => `  ${l.workspace}  (${l.identificacao})`).join('\n'),
          );
        }
        const linha = candidatas[0];
        if (linha.recusada_em) {
          throw new SondaAbortada(
            `A credencial está marcada como RECUSADA em ${linha.recusada_em}. ` +
              'A sonda não roda: mais uma tentativa pode bloquear a conta no tribunal.',
          );
        }
        const carteira = new Set(
          db
            .prepare('SELECT numero FROM acompanhamentos WHERE workspace = ?')
            .all(linha.workspace)
            .map((r) => soDigitos(r.numero)),
        );
        return {
          workspace: linha.workspace,
          identificacao: linha.identificacao,
          senhaCifrada: linha.senha_cifrada,
          carteira,
          endpoint: config.mni.endpoint,
          timeoutMs: config.mni.timeoutMs,
          limitePorMinuto: config.mni.limitePorMinuto,
          pausaApos403Ms: config.mni.pausaApos403Ms,
          chaveDoCofre: config.mni.chaveDoCofre,
        };
      } finally {
        db.close();
      }
    },

    /** GET sem credencial. Uma tentativa. */
    async baixarDocumento(url, timeoutMs = 30_000) {
      const { HttpClient } = await import('../dist/infrastructure/http/HttpClient.js');
      const http = new HttpClient({ timeoutMs, tentativas: 1 });
      let r;
      try {
        r = await http.get(url, { accept: 'text/xml, application/xml, */*' });
      } catch (e) {
        throw new SondaAbortada(`não consegui baixar o WSDL (${/timeout/i.test(String(e?.name)) ? 'timeout' : 'falha de rede'})`);
      }
      if (r.status === 403) throw new SondaAbortada('o tribunal respondeu HTTP 403 ao WSDL (bloqueio do IP). Espere; não insista.');
      if (!r.ok) throw new SondaAbortada(`o WSDL respondeu HTTP ${r.status}`);
      return r.corpo;
    },

    /** A ÚNICA saída para o tribunal com credencial: pelo MniAdapter. */
    async consultarAvisos({ contexto, acao }) {
      const { Cofre } = await import('../dist/infrastructure/seguranca/cofre.js');
      const { HttpClient } = await import('../dist/infrastructure/http/HttpClient.js');
      const { MniAdapter } = await import('../dist/infrastructure/adapters/mni/MniAdapter.js');
      const erros = await import('../dist/domain/errors/index.js');

      const senha = Cofre.comChaveBase64(contexto.chaveDoCofre).decifrar(contexto.senhaCifrada);
      const xml = envelopeAvisosPendentes({ identificacao: contexto.identificacao, senha });
      validarEnvelopeEAcao(xml, acao);

      const adapter = new MniAdapter({
        httpClient: new HttpClient({ timeoutMs: contexto.timeoutMs, tentativas: 1 }),
        endpoint: contexto.endpoint,
        limitePorMinuto: contexto.limitePorMinuto,
        pausaApos403Ms: contexto.pausaApos403Ms,
      });
      const t0 = performance.now();
      try {
        // `chamar` é privado só em tipo (TS): é a rota única do adapter para o
        // tribunal — limitador, disjuntor de 403, 429/5xx, abertura do envelope e
        // classificação de `sucesso: false`. Não duplicamos nada disso aqui.
        const { resposta, bytesResposta } = await adapter['chamar'](xml, acao, '');
        return {
          conteudo: resposta.conteudo,
          mensagem: resposta.mensagem,
          bytes: bytesResposta,
          ms: Math.round(performance.now() - t0),
        };
      } catch (e) {
        if (e instanceof erros.MniBloqueadoError) throw new SondaAbortada('o tribunal respondeu HTTP 403 (bloqueio do IP). Espere; não insista.');
        if (e instanceof erros.CredencialTribunalInvalidaError) throw new SondaAbortada(`o tribunal recusou a credencial: ${String(e.message).slice(0, 120)}`);
        if (e instanceof erros.ProviderIndisponivelError) throw new SondaAbortada(`fonte indisponível: ${String(e.message).slice(0, 120)}`);
        if (e instanceof erros.RespostaInvalidaError) throw new SondaAbortada(`resposta fora do contrato: ${String(e.message).slice(0, 120)}`);
        if (e instanceof erros.ProcessoNaoEncontradoError) throw new SondaAbortada('o tribunal respondeu sucesso=false com mensagem de "não encontrado"');
        throw new SondaAbortada(`falha inesperada (${e?.name ?? 'Error'})`);
      }
    },
  };
}

function imprimirJulgamento(resumo, escrever, opcoes) {
  const j = julgar(resumo);
  escrever('\n== 5. JULGAMENTO ==');
  escrever(`${j.rotulo} — ${j.motivo}.`);
  escrever('\nO que a sonda não conseguiu medir:');
  for (const n of naoMedido(resumo, opcoes)) escrever(`  - ${n}`);
  return j;
}

/**
 * Executa um modo. Devolve o código de saída. Tudo o que toca banco, rede ou
 * disco vem de `deps`, para o teste provar que `--seco` e `--offline` não chamam
 * nenhuma delas.
 */
export async function principal(argv, deps = dependenciasReais(), escrever = console.log) {
  let args;
  try {
    args = lerArgumentos(argv);
  } catch (e) {
    console.error(`${e.message}\n${USO}`);
    return 1;
  }
  const esperado = args['esperado'] !== undefined ? Number(args['esperado']) : undefined;
  const semLimiteEsperado = args['sem-limite-esperado'] !== undefined ? Number(args['sem-limite-esperado']) : undefined;
  const opcoesResumo = {
    ...(esperado !== undefined ? { esperado } : {}),
    ...(semLimiteEsperado !== undefined ? { semLimiteEsperado } : {}),
  };
  escrever(`sonda-avisos-pendentes v${VERSAO_SONDA}`);

  try {
    // --- --offline: só a tabela. Nem banco, nem rede, nem dist/. ---------------
    if (args['offline']) {
      let tabela;
      try {
        tabela = validarTabela(JSON.parse(deps.lerArquivo(args['offline'])));
      } catch (e) {
        console.error(`não consegui ler a tabela: ${e.message}\n${USO}`);
        return 1;
      }
      escrever('modo --offline (sem banco, sem tribunal)');
      const resumo = resumir(tabela, opcoesResumo);
      imprimirResumo(resumo, escrever);
      imprimirJulgamento(resumo, escrever, { wsdlConferido: false });
      return 0;
    }

    // --- --seco: só o plano e o envelope. --------------------------------------
    if (args['seco']) {
      escrever('modo --seco (não abre banco nem rede)');
      escrever(`operação única: ${OPERACAO} · SOAPAction: ${ACAO_AVISOS}`);
      escrever(`operações recusadas por construção: ${OPERACOES_PROIBIDAS.join(', ')}`);
      escrever('requisições ao tribunal na consulta real: 1 (mais 1 GET do WSDL, sem credencial)');
      escrever(`tabela que a consulta real grava: ${join(deps.tmpdir(), NOME_TABELA)}`);
      escrever('\nenvelope que seria enviado (identificação e senha omitidas):\n');
      const xml = envelopeParaExibir();
      validarEnvelopeEAcao(xml, ACAO_AVISOS);
      escrever(xml.replace(/></g, '>\n<'));
      escrever('\n--seco: nada foi aberto nem enviado. Fim.');
      return 0;
    }

    // --- WSDL (com ou sem a consulta) --------------------------------------------
    if (args['wsdl-arquivo']) {
      const xml = deps.lerArquivo(args['wsdl-arquivo']);
      const analise = analisarWsdl(new Map([[args['wsdl-arquivo'], xml]]));
      imprimirWsdl(analise, escrever);
      imprimirAvaliacaoWsdl(avaliarWsdl(analise), escrever);
      return 0;
    }
    if (args['wsdl']) {
      const url = args['wsdl-url'] ?? WSDL_PADRAO;
      escrever(`modo --wsdl: GET em ${url} (e nos documentos que ele importa, no mesmo host). Sem credencial.`);
      const documentos = await baixarWsdlCompleto((u) => deps.baixarDocumento(u), url);
      const analise = analisarWsdl(documentos);
      imprimirWsdl(analise, escrever);
      imprimirAvaliacaoWsdl(avaliarWsdl(analise), escrever);
      return 0;
    }

    // --- a consulta real ------------------------------------------------------------
    const tribunal = String(args['tribunal'] ?? 'TJGO').toUpperCase();
    escrever(`plano: UMA consulta ${OPERACAO} ao ${tribunal}, sem repetição, pelo MniAdapter.`);
    escrever(`operações recusadas por construção: ${OPERACOES_PROIBIDAS.join(', ')}`);

    const contexto = await deps.carregarContexto({ tribunal, workspace: args['workspace'] });
    escrever(`workspace ${contexto.workspace} · ${tribunal} · carteira ${contexto.carteira.size} processos`);

    // 1) WSDL ANTES de tocar na senha.
    const urlWsdl = args['wsdl-url'] ?? `${contexto.endpoint}?WSDL`;
    const documentos = await baixarWsdlCompleto((u) => deps.baixarDocumento(u), urlWsdl);
    const analiseWsdl = analisarWsdl(documentos);
    imprimirWsdl(analiseWsdl, escrever);
    const avaliacao = avaliarWsdl(analiseWsdl);
    imprimirAvaliacaoWsdl(avaliacao, escrever);
    if (avaliacao.abortar.length > 0) {
      throw new SondaAbortada('o WSDL não autoriza a consulta (ver acima). Nenhuma credencial foi aberta.');
    }
    validarEnvelopeEAcao(envelopeParaExibir(), avaliacao.acao);

    // 2) A consulta.
    escrever('\n[consulta] uma tentativa, pode levar dezenas de segundos...');
    const r = await deps.consultarAvisos({ contexto, acao: avaliacao.acao });
    escrever(`[consulta] ok · ${(r.ms / 1000).toFixed(1)} s · resposta ${r.bytes.toLocaleString('pt-BR')} B`);

    // 3) Análise.
    const analise = analisarResposta(r.conteudo);
    if (analise.avisos.length === 0 && r.mensagem) {
      escrever(`mensagem do tribunal (lista vazia): ${String(r.mensagem).slice(0, 120)}`);
    }
    const acompanhados = contarAcompanhados(analise.numerosPorAviso, contexto.carteira);
    const tabela = montarTabela({ chaveDaLista: analise.chaveDaLista, avisos: analise.avisos, acompanhados });
    const resumo = resumir(tabela, opcoesResumo);
    imprimirResumo(resumo, escrever);

    escrever(
      args['mostrar']
        ? '\n== 3. CONFERÊNCIA COM A TELA DO PROJUDI (só no terminal; não vai para arquivo) =='
        : '\n== 3. CONFERÊNCIA (números mascarados; use --mostrar para comparar com a tela) ==',
    );
    for (const l of linhasDeConferencia(analise, { mostrar: Boolean(args['mostrar']) })) escrever(`  ${l}`);

    // 4) Tabela.
    const destino = join(deps.tmpdir(), NOME_TABELA);
    deps.gravarArquivo(destino, JSON.stringify(validarTabela(tabela)));
    escrever(`\n== 4. TABELA ==\n[gravada em ${destino} — sem número de processo, sem texto, sem nomes, sem senha]`);
    escrever(`[reanálise sem nova consulta: node scripts/sonda-avisos-pendentes.mjs --offline=${destino}${esperado !== undefined ? ` --esperado=${esperado}` : ''}]`);

    imprimirJulgamento(resumo, escrever, { wsdlConferido: true });
    return 0;
  } catch (e) {
    if (e instanceof SondaAbortada || e instanceof OperacaoProibidaError) {
      console.error(`\nABORTADO: ${e.message}`);
      console.error('Nenhuma segunda tentativa foi feita (e nenhuma será).');
      return 2;
    }
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('\nNão achei dist/. Rode `npm run build` antes. Nada foi enviado.');
      return 1;
    }
    console.error(`\nFalha inesperada (${e?.name ?? 'Error'}). Nada foi repetido.`);
    return 3;
  }
}

function imprimirAvaliacaoWsdl(av, escrever) {
  escrever('\n-- conferência do WSDL para a consulta real --');
  if (av.abortar.length === 0) escrever('  OK: a entrada é montável pelo envelope e a documentação não indica efeito colateral.');
  for (const m of av.abortar) escrever(`  PARA: ${m}`);
  for (const m of av.avisos) escrever(`  atenção: ${m}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await principal(process.argv.slice(2));
}
