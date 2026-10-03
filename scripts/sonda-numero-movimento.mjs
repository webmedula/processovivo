#!/usr/bin/env node
/**
 * SONDA DO NÚMERO DA MOVIMENTAÇÃO — v1.0.0
 *
 * UMA pergunta: o MNI entrega, em algum campo, o número SEQUENCIAL da
 * movimentação que o advogado vê no Projudi?
 *
 * Na v0.33.3 o "mov. N" saiu da tela porque o que mostrávamos era o
 * `identificadorMovimento`, identificador INTERNO do tribunal. Esta sonda decide
 * como o número volta: campo próprio, posição na ordem do processo, ou nada.
 *
 * Uma única consulta `consultarProcesso` (`movimentos: true`,
 * `incluirDocumentos: true`, `incluirCabecalho: false`), sem baixar arquivo — a
 * listagem nunca traz o teor. Produz:
 *
 *  1. o catálogo de campos de `<movimento>` e de `<documento>` (nomes, contagem,
 *     formato do valor; literal só de atributo cujo valor é só dígitos);
 *  2. a busca de cada número conferido (igualdade exata) em todo valor da
 *     resposta, com o caminho onde apareceu;
 *  3. o teste de posição (ordem crescente e decrescente por `dataHora`);
 *  4. uma linha final: CAMPO PRÓPRIO, POSIÇÃO CRESCENTE, POSIÇÃO DECRESCENTE ou
 *     NÃO CONFIRMÁVEL, com o nível de confiança.
 *
 * Os números conferidos e as datas entram SÓ por argumento de linha de comando:
 * o repositório é público e eles vêm de um processo real. Nunca vão para arquivo
 * versionado, fixture, teste ou relatório.
 *
 * Regras de segurança, iguais às das sondas anteriores (e mais duras):
 *  - o banco abre em `readOnly`: a sonda nunca marca como recusada uma
 *    credencial que funciona;
 *  - recusa-se a rodar com credencial já marcada como recusada; com mais de uma
 *    credencial do tribunal, EXIGE `--workspace` e não escolhe sozinha;
 *  - UMA tentativa, sem repetição, em nenhuma hipótese — tentativa malsucedida
 *    conta para o bloqueio da conta do advogado. Aborta em HTTP 403, 429, 5xx,
 *    `sucesso: false`, timeout ou resposta fora do contrato, e diz o motivo;
 *  - senha e CONTEÚDO de peça nunca vão para stdout, stderr, log nem arquivo; o
 *    XML bruto não é gravado; `<conteudo>` nem é percorrido; nenhum texto livre
 *    (`descricao`, `complemento`, `NomeArquivo`, partes) é impresso;
 *  - processo em segredo de justiça: aborta ANTES de imprimir qualquer campo;
 *  - `--seco` mostra só o plano: não abre banco, não fala com o tribunal.
 *
 * Os termos de `--termos` são comparados em memória com a descrição dos atos; o
 * que sai é só "casa / não casa" por candidato, nunca o texto.
 *
 * Uso:
 *   node scripts/sonda-numero-movimento.mjs <numero-cnj> --numeros=A,B,C \
 *        --datas=AAAA-MM-DD,AAAA-MM-DD,... [--termos=,t1+t2,...] [--janela=N] \
 *        [--workspace=<nome>] [--seco]
 *
 *   --numeros   1 a 3 números conferidos no Projudi.
 *   --datas     uma data por número. A PRIMEIRA é tratada como exata (o dia do
 *               ato); as demais, como JANELAS de ±`--janela` dias (padrão 10),
 *               pois são aproximadas. `AAAA-MM-DD~N` fixa a janela daquele par
 *               (`~0` = dia exato).
 *   --termos    opcional, um por número (vazio permitido); `+` separa
 *               alternativas. Ex.: `--termos=,alvara,atualiza+calculo+debito`.
 *
 * Requer `npm run build` antes (importa de `dist/`).
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSAO_SONDA = '1.0.0';
const DESTINO = join(tmpdir(), 'sonda-numero-movimento-formas.json');
const JANELA_PADRAO = 10;
const MAX_NUMEROS = 3;
const MAX_CANDIDATOS_IMPRESSOS = 40;

// =============================================================================
// Helpers de leitura da árvore do fast-xml-parser (mesmas convenções do mapper:
// atributos com prefixo `@_`, prefixos de namespace já removidos).
// =============================================================================
const registro = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
const lista = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Texto de um nó: string pura, ou `#text` quando o nó também tem atributos. */
function textoDe(no) {
  if (typeof no === 'string') return no;
  if (typeof no === 'number' || typeof no === 'boolean') return String(no);
  const r = registro(no);
  const t = r?.['#text'];
  return t === undefined ? undefined : String(t);
}

const normalizar = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function dataValida(ano, mes, dia) {
  return ano >= 1990 && ano <= 2100 && mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31;
}

/** Formato do valor, SEM revelar o valor. */
export function formatoDe(valor) {
  const v = String(valor).trim();
  if (v === '') return 'vazio';
  if (/^\d+$/.test(v)) {
    const ano = Number(v.slice(0, 4));
    const mes = Number(v.slice(4, 6));
    const dia = Number(v.slice(6, 8));
    if (v.length === 14 && dataValida(ano, mes, dia)) return 'data-hora (14 dígitos)';
    if (v.length === 8 && dataValida(ano, mes, dia)) return 'data (8 dígitos)';
    return `só dígitos (${v.length})`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return 'data ISO';
  if (/^(true|false)$/i.test(v)) return 'booleano';
  return v.length <= 40 ? 'texto curto' : 'texto longo';
}

/** Dígitos que a sonda pode mostrar por extenso: não é data e cabe num inteiro seguro. */
function digitoLiteral(valor) {
  const v = String(valor).trim();
  if (!/^\d{1,12}$/.test(v)) return undefined;
  return formatoDe(v).startsWith('só dígitos') ? v : undefined;
}

const SALTAR = new Set(['conteudo']); // o teor da peça nunca é percorrido

/**
 * Percorre um nó e chama `visita(caminhoRelativo, valor)` para cada atributo e
 * texto. `outroParametro` vira `outroParametro[@nome=X]/@valor`.
 */
function varrer(no, caminho, visita) {
  if (typeof no === 'string' || typeof no === 'number' || typeof no === 'boolean') {
    visita(caminho, String(no));
    return;
  }
  const r = registro(no);
  if (!r) return;
  const ehParametro = caminho.split('/').pop() === 'outroParametro';
  const rotuloParametro = ehParametro ? textoDe(r['@_nome']) : undefined;
  for (const [chave, valor] of Object.entries(r)) {
    if (chave.startsWith('@_')) {
      const nome = chave.slice(2);
      if (ehParametro && nome === 'nome') continue;
      const base =
        ehParametro && rotuloParametro !== undefined
          ? caminho.replace(/outroParametro$/, `outroParametro[@nome=${rotuloParametro}]`)
          : caminho;
      visita(`${base}/@${nome}`, String(valor));
    } else if (chave === '#text') {
      visita(caminho, String(valor));
    } else if (!SALTAR.has(chave)) {
      for (const filho of lista(valor)) varrer(filho, `${caminho}/${chave}`, visita);
    }
  }
}

const semIndice = (c) => c; // os caminhos já são genéricos (sem índice de lista)

// =============================================================================
// Análise (pura: recebe o `conteudo` já aberto e devolve o relatório)
// =============================================================================

/** Normaliza os argumentos em pares número↔data(janela)↔termos. Lança Error com a mensagem de uso. */
export function interpretarPares({ numeros, datas, termos, janela }) {
  const ns = (numeros ?? '').split(',').filter((x) => x !== '');
  const ds = (datas ?? '').split(',').filter((x) => x !== '');
  if (ns.length < 1 || ns.length > MAX_NUMEROS) {
    throw new Error(`--numeros precisa ter de 1 a ${MAX_NUMEROS} números.`);
  }
  if (ds.length !== ns.length) {
    throw new Error('--datas precisa ter UMA data por número (mesma ordem).');
  }
  const ts = termos === undefined ? ns.map(() => '') : termos.split(',');
  if (ts.length !== ns.length) {
    throw new Error('--termos precisa ter um item por número (vazio permitido).');
  }
  const janelaGeral = janela === undefined ? JANELA_PADRAO : Number(janela);
  if (!Number.isInteger(janelaGeral) || janelaGeral < 0 || janelaGeral > 60) {
    throw new Error('--janela precisa ser um inteiro de 0 a 60.');
  }
  return ns.map((n, k) => {
    if (!/^\d{1,9}$/.test(n) || Number(n) < 1) {
      throw new Error(`número inválido em --numeros (posição ${k + 1}).`);
    }
    const [dataTxt, janelaTxt] = ds[k].split('~');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataTxt)) {
      throw new Error(`data inválida em --datas (posição ${k + 1}); use AAAA-MM-DD.`);
    }
    const [a, m, d] = dataTxt.split('-').map(Number);
    if (!dataValida(a, m, d)) throw new Error(`data inexistente em --datas (posição ${k + 1}).`);
    let jan = k === 0 ? 0 : janelaGeral;
    if (janelaTxt !== undefined) {
      jan = Number(janelaTxt);
      if (!Number.isInteger(jan) || jan < 0 || jan > 60) {
        throw new Error(`janela inválida em --datas (posição ${k + 1}).`);
      }
    }
    return {
      numero: Number(n),
      data: dataTxt,
      janela: jan,
      termos: ts[k]
        .split('+')
        .map((t) => normalizar(t.trim()))
        .filter((t) => t !== ''),
    };
  });
}

const DIA_MS = 86_400_000;
const diaParaMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const diaDeDataHora = (dh) =>
  dh.length >= 8 ? `${dh.slice(0, 4)}-${dh.slice(4, 6)}-${dh.slice(6, 8)}` : undefined;

/**
 * @param conteudo o corpo de `consultarProcessoResposta`, como `abrirEnvelope` devolve
 * @param pares saída de `interpretarPares`
 * @returns { abortar?: string, relatorio?: object }
 */
export function analisar(conteudo, pares) {
  const processo = registro(conteudo?.processo);
  if (!processo) return { abortar: 'a resposta não trouxe <processo>: fora do contrato.' };

  // --- sigilo: ANTES de qualquer campo -----------------------------------------
  const sigiloDoProcesso = [
    textoDe(processo['@_nivelSigilo']),
    textoDe(registro(processo.dadosBasicos)?.['@_nivelSigilo']),
  ]
    .filter((x) => x !== undefined)
    .map(Number)
    .some((n) => Number.isFinite(n) && n > 0);
  if (sigiloDoProcesso) {
    return {
      abortar:
        'o processo está sob SEGREDO DE JUSTIÇA (nivelSigilo > 0). Nada foi impresso ' +
        'nem gravado; a sonda não roda neste processo.',
    };
  }
  const sigiloVerificavel = registro(processo.dadosBasicos) !== undefined;

  const movimentosBrutos = lista(processo.movimento);
  const documentosBrutos = lista(processo.documento);

  // --- 1. catálogo ---------------------------------------------------------------
  const catalogo = { movimento: new Map(), documento: new Map() };
  function registrarNoCatalogo(tipo, caminho, valor) {
    const mapa = catalogo[tipo];
    let item = mapa.get(caminho);
    if (!item) {
      item = { ocorrencias: 0, formatos: new Map(), digitos: [] };
      mapa.set(caminho, item);
    }
    item.ocorrencias += 1;
    const f = formatoDe(valor);
    item.formatos.set(f, (item.formatos.get(f) ?? 0) + 1);
    const lit = digitoLiteral(valor);
    if (lit !== undefined) item.digitos.push(lit);
  }

  // Cada movimento vira um registro plano: campos (caminho → valor) + dataHora + textos.
  const movs = movimentosBrutos.map((bruto, i) => {
    const campos = [];
    varrer(bruto, 'movimento', (c, v) => {
      campos.push([c, v]);
      registrarNoCatalogo('movimento', c, v);
    });
    const r = registro(bruto) ?? {};
    const dh = textoDe(r['@_dataHora'])?.trim() ?? '';
    const id = textoDe(r['@_identificadorMovimento'])?.trim() ?? '';
    const textos = campos
      .filter(([c, v]) => !/^\d+$/.test(v.trim()) && c !== 'movimento/@dataHora')
      .map(([, v]) => normalizar(v))
      .join(' | ');
    return { i, id, dh, dia: diaDeDataHora(dh), campos, textos, docs: [] };
  });

  const porId = new Map();
  for (const m of movs) if (m.id && !porId.has(m.id)) porId.set(m.id, m);

  // Documentos (achatando vinculados) ligados ao movimento pelo atributo `movimento`.
  const docs = [];
  function coletarDoc(bruto, ehVinculado) {
    const r = registro(bruto);
    if (!r) return;
    const campos = [];
    varrer(bruto, ehVinculado ? 'documento/documentoVinculado' : 'documento', (c, v) => {
      campos.push([c, v]);
      registrarNoCatalogo('documento', c.replace(/^documento\//, '') || 'documento', v);
    });
    const dh = textoDe(r['@_dataHora'])?.trim() ?? '';
    const idMov = textoDe(r['@_movimento'])?.trim() ?? '';
    const sigilo = Number(textoDe(r['@_nivelSigilo']) ?? 0);
    const doc = {
      campos,
      dia: diaDeDataHora(dh),
      idMov,
      descricao: normalizar(textoDe(r['@_descricao']) ?? ''),
      sigilo: Number.isFinite(sigilo) ? sigilo : 0,
    };
    docs.push(doc);
    const alvo = porId.get(idMov);
    if (alvo) alvo.docs.push(doc);
    for (const v of lista(r.documentoVinculado)) coletarDoc(v, true);
  }
  for (const d of documentosBrutos) coletarDoc(d, false);

  // --- 2. busca dos números ---------------------------------------------------------
  const igual = (valor, n) => {
    const v = valor.trim();
    return v === String(n) || (/^\d+$/.test(v) && Number(v) === n);
  };
  const acertos = pares.map(() => []); // por par: { caminho, escopo, mov }
  function procurar(escopo, mov, caminho, valor) {
    pares.forEach((p, k) => {
      if (igual(valor, p.numero)) acertos[k].push({ caminho, escopo, mov });
    });
  }
  movs.forEach((m) => m.campos.forEach(([c, v]) => procurar('movimento', m, semIndice(c), v)));
  docs.forEach((d) => {
    const alvo = porId.get(d.idMov);
    d.campos.forEach(([c, v]) => procurar('documento', alvo, semIndice(c), v));
  });
  for (const [chave, valor] of Object.entries(processo)) {
    if (chave === 'movimento' || chave === 'documento' || SALTAR.has(chave)) continue;
    for (const filho of lista(valor)) {
      varrer(filho, `processo/${chave}`, (c, v) => procurar('outro', undefined, c, v));
    }
  }

  // --- 3. posição ---------------------------------------------------------------------
  const comData = movs.filter((m) => m.dh !== '');
  const semData = movs.length - comData.length;
  const asc = [...comData].sort((a, b) => (a.dh < b.dh ? -1 : a.dh > b.dh ? 1 : a.i - b.i));
  const desc = [...comData].sort((a, b) => (a.dh > b.dh ? -1 : a.dh < b.dh ? 1 : a.i - b.i));
  const posAsc = new Map(asc.map((m, idx) => [m, idx + 1]));
  const posDesc = new Map(desc.map((m, idx) => [m, idx + 1]));

  const empates = comData.length - new Set(comData.map((m) => m.dh)).size;

  // Candidatos de cada par: atos na janela de datas + atos ligados a peças da janela.
  const candidatos = pares.map((p) => {
    const centro = diaParaMs(p.data);
    const dentro = (dia) =>
      dia !== undefined && Math.abs(diaParaMs(dia) - centro) <= p.janela * DIA_MS;
    const mapa = new Map();
    for (const m of comData) {
      if (dentro(m.dia)) mapa.set(m, { m, via: new Set(['ato']) });
    }
    for (const d of docs) {
      const alvo = porId.get(d.idMov);
      if (!alvo || alvo.dh === '' || !dentro(d.dia)) continue;
      const atual = mapa.get(alvo) ?? { m: alvo, via: new Set() };
      atual.via.add('peça');
      mapa.set(alvo, atual);
    }
    return [...mapa.values()]
      .sort((a, b) => posAsc.get(a.m) - posAsc.get(b.m))
      .map(({ m, via }) => ({
        m,
        via: [...via].join('+'),
        asc: posAsc.get(m),
        desc: posDesc.get(m),
        casaTermos:
          p.termos.length === 0
            ? null
            : p.termos.some(
                (t) => m.textos.includes(t) || m.docs.some((d) => d.descricao.includes(t)),
              ),
      }));
  });

  // Lacunas em identificadorMovimento.
  const idsNum = movs.map((m) => m.id).filter((x) => /^\d+$/.test(x)).map(Number);
  const idsOrdenados = [...idsNum].sort((a, b) => a - b);
  let saltos = 0;
  for (let i = 1; i < idsOrdenados.length; i++) {
    if (idsOrdenados[i] - idsOrdenados[i - 1] !== 1) saltos += 1;
  }

  // Monotonia de campos numéricos de movimento em relação à data.
  const monotonia = [];
  for (const [caminho, item] of catalogo.movimento) {
    if (item.digitos.length < 2 || item.digitos.length !== item.ocorrencias) continue;
    const valores = asc
      .map((m) => m.campos.find(([c]) => c === caminho)?.[1])
      .filter((v) => v !== undefined && digitoLiteral(v) !== undefined)
      .map(Number);
    if (valores.length < 2 || new Set(valores).size < 2) continue;
    const cresc = valores.every((v, i) => i === 0 || v >= valores[i - 1]);
    const decr = valores.every((v, i) => i === 0 || v <= valores[i - 1]);
    monotonia.push({ caminho, sentido: cresc ? 'crescente' : decr ? 'decrescente' : 'não monotônico' });
  }

  // --- veredito por posição ---------------------------------------------------------------
  function vereditoPosicao(chave) {
    const exatos = pares.map((p, k) => candidatos[k].filter((c) => c[chave] === p.numero));
    const firmeOk = exatos[0].length > 0;
    // Cronologia: com os atos escolhidos, o número maior tem de ser o ato mais recente.
    const escolha = pares.map((p, k) => exatos[k][0]);
    const todos = exatos.every((e) => e.length > 0);
    let cronologiaOk = true;
    if (todos) {
      const ord = pares
        .map((p, k) => ({ n: p.numero, m: escolha[k].m }))
        .sort((a, b) => a.n - b.n);
      for (let i = 1; i < ord.length; i++) {
        const a = ord[i - 1].m;
        const b = ord[i].m;
        if (!(a.dh < b.dh || (a.dh === b.dh && a.i < b.i))) cronologiaOk = false;
      }
    }
    const pontos = exatos.filter((e) => e.length > 0).length;
    let nivel = 0;
    if (firmeOk) nivel = todos && cronologiaOk && pares.length > 1 ? 2 : 1;
    return { exatos, firmeOk, todos, cronologiaOk, pontos, nivel };
  }
  const posicao = {
    crescente: vereditoPosicao('asc'),
    decrescente: vereditoPosicao('desc'),
  };

  // --- veredito por campo próprio -------------------------------------------------------------
  const caminhosDoFirme = new Map();
  for (const a of acertos[0]) {
    if (a.escopo === 'outro' || !a.mov) continue;
    if (!candidatos[0].some((c) => c.m === a.mov)) continue;
    caminhosDoFirme.set(a.caminho, true);
  }
  const campos = [];
  for (const caminho of caminhosDoFirme.keys()) {
    const noPar = pares.map((p, k) =>
      acertos[k].some(
        (a) =>
          a.caminho === caminho && a.mov && candidatos[k].some((c) => c.m === a.mov),
      ),
    );
    const todos = noPar.every(Boolean);
    let cronologiaOk = true;
    if (todos) {
      const ord = pares
        .map((p, k) => ({
          n: p.numero,
          m: acertos[k].find(
            (a) => a.caminho === caminho && a.mov && candidatos[k].some((c) => c.m === a.mov),
          ).mov,
        }))
        .sort((a, b) => a.n - b.n);
      for (let i = 1; i < ord.length; i++) {
        const a = ord[i - 1].m;
        const b = ord[i].m;
        if (!(a.dh < b.dh || (a.dh === b.dh && a.i < b.i))) cronologiaOk = false;
      }
    }
    campos.push({
      caminho,
      noPar,
      cronologiaOk,
      nivel: todos && cronologiaOk && pares.length > 1 ? 2 : 1,
    });
  }
  campos.sort((a, b) => b.nivel - a.nivel);

  // --- catálogo em forma serializável --------------------------------------------------------
  const estatistica = (item) => {
    if (item.digitos.length === 0) return undefined;
    const distintos = [...new Set(item.digitos)];
    const nums = distintos.map(Number);
    return {
      distintos: distintos.length,
      minimo: Math.min(...nums),
      maximo: Math.max(...nums),
      amostra: distintos.slice(0, 5),
    };
  };
  const serializar = (mapa) =>
    [...mapa.entries()].map(([caminho, item]) => ({
      caminho,
      ocorrencias: item.ocorrencias,
      formatos: Object.fromEntries(item.formatos),
      digitos: estatistica(item),
    }));

  return {
    relatorio: {
      versao: VERSAO_SONDA,
      totais: {
        movimentos: movs.length,
        movimentosSemDataHora: semData,
        documentos: documentosBrutos.length,
        documentosContandoVinculados: docs.length,
        documentosSigilosos: docs.filter((d) => d.sigilo > 0).length,
        dataHoraRepetida: empates,
        identificadoresDistintos: new Set(idsNum).size,
        identificadoresConsecutivos: saltos === 0 && idsNum.length > 1,
        saltosNosIdentificadores: saltos,
      },
      sigiloDoProcessoVerificavel: sigiloVerificavel,
      catalogo: {
        movimento: serializar(catalogo.movimento),
        documento: serializar(catalogo.documento),
      },
      monotonia,
      busca: pares.map((p, k) => {
        const porCaminho = new Map();
        for (const a of acertos[k]) {
          const chave = `${a.caminho}${
            a.mov && candidatos[k].some((c) => c.m === a.mov) ? '  [em ato candidato]' : ''
          }`;
          porCaminho.set(chave, (porCaminho.get(chave) ?? 0) + 1);
        }
        return { ocorrencias: [...porCaminho.entries()] };
      }),
      candidatos: candidatos.map((lst, k) => ({
        janelaDias: pares[k].janela,
        total: lst.length,
        itens: lst.map((c) => ({
          asc: c.asc,
          desc: c.desc,
          id: c.m.id,
          dia: c.m.dia,
          via: c.via,
          documentos: c.m.docs.length,
          casaTermos: c.casaTermos,
        })),
      })),
      posicao: {
        crescente: resumo(posicao.crescente, pares),
        decrescente: resumo(posicao.decrescente, pares),
      },
      campos: campos.map((c) => ({
        caminho: c.caminho,
        pares: c.noPar,
        cronologiaOk: c.cronologiaOk,
        nivel: c.nivel,
      })),
      conclusao: concluir(pares, campos, posicao),
    },
  };
}

function resumo(v, pares) {
  return {
    firmeOk: v.firmeOk,
    paresComPosicaoIgual: v.pontos,
    totalDePares: pares.length,
    cronologiaOk: v.cronologiaOk,
    nivel: v.nivel,
  };
}

const ROTULO_NIVEL = {
  2: 'CONFIRMADO',
  1: 'COMPATÍVEL (1 ponto)',
};

function concluir(pares, campos, posicao) {
  const candidatosDeConclusao = [];
  for (const c of campos) {
    const pontos = c.noPar.filter(Boolean).length;
    candidatosDeConclusao.push({
      rank: c.nivel * 10 + 1,
      rotulo: `CAMPO PRÓPRIO: ${c.caminho}`,
      nivel: c.nivel,
      motivo:
        c.nivel === 2
          ? `valor igual ao número conferido em ${pontos} de ${pares.length} atos candidatos, em ordem cronológica crescente`
          : `valor igual ao número conferido em ${pontos} de ${pares.length} atos candidatos${
              c.cronologiaOk ? '' : ' (ordem cronológica NÃO mantida)'
            }`,
    });
  }
  for (const [sentido, v] of [
    ['CRESCENTE', posicao.crescente],
    ['DECRESCENTE', posicao.decrescente],
  ]) {
    if (v.nivel === 0) continue;
    candidatosDeConclusao.push({
      rank: v.nivel * 10,
      rotulo: `POSIÇÃO ${sentido}`,
      nivel: v.nivel,
      motivo:
        v.nivel === 2
          ? `a posição reproduz os ${pares.length} números conferidos, em ordem cronológica`
          : `a posição reproduz ${v.pontos} de ${pares.length} números` +
            (v.pontos === pares.length && !v.cronologiaOk
              ? ' (cronologia invertida: contradiz a verdade de campo)'
              : v.pontos === 1 && pares.length > 1
                ? ' — só o primeiro bate'
                : ''),
    });
  }
  candidatosDeConclusao.sort((a, b) => b.rank - a.rank);
  const melhor = candidatosDeConclusao[0];
  if (!melhor) {
    return {
      rotulo: 'NÃO CONFIRMÁVEL',
      confianca: 'nenhuma',
      motivo:
        'nenhum campo traz o número conferido num ato candidato, e nenhuma ordem por ' +
        'dataHora reproduz a posição',
    };
  }
  return { rotulo: melhor.rotulo, confianca: ROTULO_NIVEL[melhor.nivel], motivo: melhor.motivo };
}

// =============================================================================
// Impressão
// =============================================================================
export function imprimir(rel, pares, escrever = console.log) {
  const t = rel.totais;
  escrever('== TOTAIS ==');
  escrever(
    `movimentos: ${t.movimentos} (sem dataHora: ${t.movimentosSemDataHora}) · documentos: ` +
      `${t.documentos} (com vinculados: ${t.documentosContandoVinculados}, sigilosos: ${t.documentosSigilosos})`,
  );
  escrever(
    `dataHora repetida (empates): ${t.dataHoraRepetida > 0 ? `sim (${t.dataHoraRepetida} atos a mais que horários distintos)` : 'não'}`,
  );
  escrever(
    `identificadorMovimento: ${t.identificadoresDistintos} distintos · consecutivos: ` +
      `${t.identificadoresConsecutivos ? 'sim' : `não (${t.saltosNosIdentificadores} saltos)`}`,
  );
  if (!rel.sigiloDoProcessoVerificavel) {
    escrever(
      'aviso: sem cabeçalho (incluirCabecalho=false) o nível de sigilo do PROCESSO não ' +
        'é verificável nesta resposta; só se imprime forma, contagem e dígitos.',
    );
  }

  for (const tipo of ['movimento', 'documento']) {
    escrever(`\n== 1. CATÁLOGO — <${tipo}> ==`);
    for (const c of rel.catalogo[tipo]) {
      const formatos = Object.entries(c.formatos)
        .map(([f, n]) => `${f}×${n}`)
        .join(', ');
      let extra = '';
      if (c.digitos) {
        extra = ` · valores: ${c.digitos.distintos} distintos, mín ${c.digitos.minimo}, máx ${c.digitos.maximo}, amostra [${c.digitos.amostra.join(', ')}]`;
      }
      escrever(`  ${c.caminho}  ocorrências ${c.ocorrencias} · ${formatos}${extra}`);
    }
  }
  if (rel.monotonia.length > 0) {
    escrever('\nCampos numéricos de movimento vs. data (ordem por dataHora):');
    for (const m of rel.monotonia) escrever(`  ${m.caminho}: ${m.sentido}`);
  }

  escrever('\n== 2. BUSCA DOS NÚMEROS CONFERIDOS (igualdade exata em todo valor) ==');
  pares.forEach((p, k) => {
    const b = rel.busca[k];
    escrever(`  ato ${String.fromCharCode(65 + k)}:`);
    if (b.ocorrencias.length === 0) escrever('    nenhuma ocorrência');
    for (const [caminho, n] of b.ocorrencias) escrever(`    ${caminho} — ${n} ocorrência(s)`);
  });

  escrever('\n== 3. TESTE DE POSIÇÃO ==');
  pares.forEach((p, k) => {
    const c = rel.candidatos[k];
    escrever(
      `  ato ${String.fromCharCode(65 + k)} — janela ±${c.janelaDias} dia(s): ${c.total} candidato(s)`,
    );
    for (const i of c.itens.slice(0, MAX_CANDIDATOS_IMPRESSOS)) {
      const marca = [];
      if (i.asc === p.numero) marca.push('POSIÇÃO CRESC. = número');
      if (i.desc === p.numero) marca.push('POSIÇÃO DECR. = número');
      escrever(
        `    ${i.dia} · pos↑ ${i.asc} · pos↓ ${i.desc} · id ${i.id || '—'} · via ${i.via} · docs ${i.documentos}` +
          (i.casaTermos === null ? '' : ` · termo: ${i.casaTermos ? 'casa' : 'não casa'}`) +
          (marca.length ? `  <== ${marca.join('; ')}` : ''),
      );
    }
    if (c.total > MAX_CANDIDATOS_IMPRESSOS) {
      escrever(`    … e mais ${c.total - MAX_CANDIDATOS_IMPRESSOS} (reduza --janela)`);
    }
  });
  for (const [nome, v] of [
    ['crescente', rel.posicao.crescente],
    ['decrescente', rel.posicao.decrescente],
  ]) {
    escrever(
      `  ordem ${nome}: reproduz o 1º número: ${v.firmeOk ? 'sim' : 'não'} · pares com posição igual ao número: ` +
        `${v.paresComPosicaoIgual}/${v.totalDePares} · cronologia mantida: ${v.cronologiaOk ? 'sim' : 'não'}`,
    );
  }
  if (rel.campos.length > 0) {
    escrever('  campos que repetem o 1º número no ato candidato:');
    for (const c of rel.campos) {
      escrever(
        `    ${c.caminho} — atos que também batem: [${c.pares.map((x) => (x ? 'sim' : 'não')).join(', ')}] · cronologia ${c.cronologiaOk ? 'ok' : 'NÃO ok'}`,
      );
    }
  }

  escrever('\n== 4. CONCLUSÃO ==');
  const c = rel.conclusao;
  escrever(`${c.rotulo} — confiança: ${c.confianca}. ${c.motivo}.`);
}

// =============================================================================
// Execução
// =============================================================================
function lerArgumentos(entrada) {
  const valor = (nome) => entrada.find((a) => a.startsWith(`--${nome}=`))?.slice(nome.length + 3);
  return {
    seco: entrada.includes('--seco'),
    numeros: valor('numeros'),
    datas: valor('datas'),
    termos: valor('termos'),
    janela: valor('janela'),
    workspace: valor('workspace'),
    posicionais: entrada.filter((a) => !a.startsWith('--')),
  };
}

function uso(mensagem) {
  if (mensagem) console.error(`${mensagem}\n`);
  console.error(
    'Uso: node scripts/sonda-numero-movimento.mjs <numero-cnj> --numeros=A,B,C ' +
      '--datas=AAAA-MM-DD,AAAA-MM-DD,... [--termos=,t1+t2] [--janela=N] ' +
      '[--workspace=<nome>] [--seco]',
  );
  process.exit(1);
}

function abortar(motivo) {
  console.error(`\nABORTADO: ${motivo}`);
  console.error('Nenhuma segunda tentativa foi feita (e nenhuma será).');
  process.exit(2);
}

async function principal() {
  const args = lerArgumentos(process.argv.slice(2));
  const [numeroBruto] = args.posicionais;
  if (!numeroBruto) uso('Faltou o número do processo.');

  let pares;
  try {
    pares = interpretarPares(args);
  } catch (e) {
    uso(e.message);
  }

  const { NumeroCNJ } = await import('../dist/domain/entities/NumeroCNJ.js').catch(() => {
    console.error('Não achei dist/. Rode `npm run build` antes.');
    process.exit(1);
  });
  const numero = NumeroCNJ.criar(numeroBruto);
  const tribunal = (numero.siglaTribunal ?? '').toUpperCase();

  console.log(`sonda-numero-movimento v${VERSAO_SONDA}`);
  console.log(
    `plano: UMA consulta consultarProcesso (movimentos=true, incluirDocumentos=true, ` +
      `incluirCabecalho=false) a um processo ${tribunal}, sem baixar arquivo, sem repetição.`,
  );
  console.log(`números conferidos: ${pares.length} (ato A${pares.length > 1 ? '…' + String.fromCharCode(64 + pares.length) : ''})`);
  pares.forEach((p, k) => {
    console.log(
      `  ato ${String.fromCharCode(65 + k)}: ${p.janela === 0 ? 'dia exato' : `janela ±${p.janela} dia(s)`}` +
        (p.termos.length ? ` · termos: ${p.termos.length}` : ''),
    );
  });
  console.log('requisições ao tribunal: 1');
  console.log(`grava só formas em: ${DESTINO}`);
  if (args.seco) {
    console.log('\n--seco: nada foi aberto nem enviado. Fim.');
    return;
  }

  // --- credencial (mesmo caminho das outras sondas) ---------------------------------
  const { DatabaseSync } = await import('node:sqlite');
  const { Cofre } = await import('../dist/infrastructure/seguranca/cofre.js');
  const { HttpClient } = await import('../dist/infrastructure/http/HttpClient.js');
  const { carregarConfig } = await import('../dist/infrastructure/config/env.js');
  const { envelopeConsultarProcesso, ACAO_CONSULTAR_PROCESSO } = await import(
    '../dist/infrastructure/adapters/mni/mni.envelope.js'
  );
  const { abrirEnvelope, XmlIlegivelError } = await import(
    '../dist/infrastructure/adapters/mni/mni.mapper.js'
  );
  const { lerRespostaSoap, MultipartInvalidoError } = await import(
    '../dist/infrastructure/adapters/mni/mtom.js'
  );

  const config = carregarConfig(process.env);
  const db = new DatabaseSync(config.banco.caminho, { readOnly: true });
  const linhas = db
    .prepare('SELECT * FROM credenciais_tribunal WHERE tribunal = ?')
    .all(tribunal);
  if (linhas.length === 0) {
    console.error(`Nenhuma credencial cadastrada para ${tribunal}.`);
    process.exit(1);
  }
  const candidatas = args.workspace
    ? linhas.filter((l) => l.workspace === args.workspace)
    : linhas;
  if (candidatas.length === 0) {
    console.error(`Nenhuma credencial de ${tribunal} no workspace "${args.workspace}".`);
    process.exit(1);
  }
  if (candidatas.length > 1) {
    console.error(
      `Há ${candidatas.length} credenciais de ${tribunal}. Escolha o workspace com --workspace=<nome>:\n` +
        candidatas.map((l) => `  ${l.workspace}  (${l.identificacao})`).join('\n'),
    );
    process.exit(1);
  }
  const linha = candidatas[0];
  if (linha.recusada_em) {
    console.error(
      `A credencial está marcada como RECUSADA em ${linha.recusada_em}.\n` +
        'A sonda não roda: mais uma tentativa pode bloquear a conta no tribunal.',
    );
    process.exit(1);
  }
  const cofre = Cofre.comChaveBase64(config.mni.chaveDoCofre);
  const credencial = {
    tribunal,
    identificacao: linha.identificacao,
    senha: cofre.decifrar(linha.senha_cifrada),
  };
  console.log(`workspace ${linha.workspace} · ${tribunal} · consulta única\n`);

  // --- UMA chamada, sem retry --------------------------------------------------------
  const http = new HttpClient({ timeoutMs: config.mni.timeoutMs, tentativas: 1 });
  const xml = envelopeConsultarProcesso({
    numeroProcesso: numero.digitos,
    credencial,
    movimentos: true,
    incluirCabecalho: false,
    incluirDocumentos: true,
  });
  console.log('[consulta] pode levar dezenas de segundos...');
  const t0 = performance.now();
  let bruta;
  try {
    bruta = await http.postXml(config.mni.endpoint, xml, { SOAPAction: ACAO_CONSULTAR_PROCESSO });
  } catch (erro) {
    const timeout = /timeout|abort/i.test(`${erro?.name} ${erro?.message}`);
    abortar(timeout ? 'timeout da consulta' : 'falha de rede na consulta');
  }
  const ms = Math.round(performance.now() - t0);

  if (bruta.status === 403) abortar('o tribunal respondeu HTTP 403 (bloqueio do IP). Espere; não insista.');
  if (bruta.status === 429) abortar('o tribunal respondeu HTTP 429 (limite de requisições).');
  if (bruta.status >= 500) abortar(`o tribunal respondeu HTTP ${bruta.status}.`);
  if (bruta.status >= 400) abortar(`o tribunal respondeu HTTP ${bruta.status}.`);

  let resposta;
  try {
    const lida = lerRespostaSoap(bruta.contentType, bruta.bytes);
    resposta = abrirEnvelope(lida.xml);
  } catch (erro) {
    if (erro instanceof MultipartInvalidoError || erro instanceof XmlIlegivelError) {
      abortar(`resposta fora do contrato (${erro.message.slice(0, 120)}).`);
    }
    throw erro;
  }
  if (!resposta.sucesso) {
    // Mensagem do tribunal ("Usuário ou Senha inválida."...), nunca a credencial.
    abortar(`o tribunal respondeu sucesso=false: ${resposta.mensagem.slice(0, 120)}`);
  }
  console.log(`[consulta] ok · ${(ms / 1000).toFixed(1)} s · resposta ${bruta.bytes.length.toLocaleString('pt-BR')} B\n`);

  // --- análise e relatório ------------------------------------------------------------
  const { abortar: motivo, relatorio } = analisar(resposta.conteudo, pares);
  if (motivo) abortar(motivo);
  imprimir(relatorio, pares);
  writeFileSync(DESTINO, JSON.stringify(relatorio, null, 2));
  console.log(`\n[formas gravadas em ${DESTINO} — sem texto livre, sem XML, sem senha]`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await principal();
}
