import { descricaoDoAto } from '../../domain/entities/descricaoDoAto.js';

/**
 * Montagem PURA do e-mail de atualizações (v0.63.0): lista curta, uma linha por
 * processo, só número, tipo do ato e data.
 *
 * O que NÃO entra, de propósito: nome de parte, classe, tribunal, trecho do
 * ato, "detectado há", resumo de IA, selos e explicações. O e-mail sai do nosso
 * controle (fica anos numa caixa de entrada, encaminhado, indexado), então
 * leva o mínimo para a pessoa decidir se abre o app. Quem monta a linha
 * (`ServicoNotificacao`) só entrega os campos já decididos; este módulo não lê
 * banco, relógio nem rede.
 */

/** Quantos processos aparecem; o resto vira "e mais N". */
export const LIMITE_DE_PROCESSOS_NO_EMAIL = 10;

const LIMITE_DO_TIPO = 80;

export type EtiquetaDoAto = 'Intimação' | 'Citação';

export interface LinhaDoAviso {
  /** 20 dígitos. Ignorado (e nunca impresso) quando `sigiloso`. */
  readonly numero: string;
  /** Número com a máscara do CNJ, para exibir. */
  readonly numeroFormatado: string;
  readonly sigiloso: boolean;
  /** Título do ato como o tribunal informou. Ignorado quando `sigiloso`. */
  readonly tipo: string;
  readonly etiqueta?: EtiquetaDoAto;
  /** Data do ato (não a da detecção). */
  readonly data: Date;
}

export interface EntradaDoAviso {
  /** As primeiras `LIMITE_DE_PROCESSOS_NO_EMAIL` linhas, na ordem da lista. */
  readonly linhas: readonly LinhaDoAviso[];
  /** Processos com novidade, mostrados ou não. */
  readonly totalDeProcessos: number;
  /** Endereço público do app, sem barra final. Ausente = e-mail sem links. */
  readonly urlBase?: string;
}

export interface AvisoMontado {
  readonly assunto: string;
  readonly texto: string;
  readonly html: string;
}

/**
 * Cores do console (`ui/estilos.ts`), repetidas aqui porque o e-mail não carrega
 * CSS do app. O teste confere o contraste de cada par (>= 4,5:1) nos dois modos.
 */
export const CORES_DO_EMAIL = {
  claro: {
    fundo: '#f4f6f9',
    papel: '#ffffff',
    tinta: '#0b192c',
    tinta2: '#475569',
    linha: '#e3e8ef',
    botao: '#163057',
    botaoTinta: '#ffffff',
    link: '#1f4e9e',
  },
  escuro: {
    fundo: '#0b1220',
    papel: '#111b2e',
    tinta: '#e8eef7',
    tinta2: '#a7b4c8',
    linha: '#223049',
    botao: '#3a6bc4',
    botaoTinta: '#ffffff',
    link: '#8ab4ff',
  },
} as const;

export function assuntoDoAviso(processos: number): string {
  return processos === 1
    ? 'Processo Vivo: 1 atualização nos seus processos'
    : `Processo Vivo: ${processos} atualizações nos seus processos`;
}

export function montarAvisoDeAtualizacoes(entrada: EntradaDoAviso): AvisoMontado {
  const { linhas, totalDeProcessos } = entrada;
  const urlBase = entrada.urlBase?.replace(/\/+$/, '');
  const urlAtualizacoes = urlBase ? `${urlBase}/#/atualizacoes` : undefined;
  const urlPreferencias = urlBase ? `${urlBase}/#/vigilancia` : undefined;
  const restantes = Math.max(0, totalDeProcessos - linhas.length);

  const abertura =
    totalDeProcessos === 1
      ? 'Houve novidade neste processo:'
      : 'Houve novidade nestes processos:';
  const maisTexto =
    restantes === 0
      ? undefined
      : restantes === 1
        ? 'e mais 1 processo'
        : `e mais ${restantes} processos`;
  const motivo = 'Você recebe este aviso porque ativou as notificações no Processo Vivo.';

  const itens = linhas.map((l) => ({
    l,
    descricao: descricaoDaLinha(l),
    data: formatarData(l.data),
  }));

  // ---------- texto puro ----------
  const texto: string[] = ['Processo Vivo', '', abertura, ''];
  for (const i of itens) {
    texto.push(`${i.l.sigiloso ? 'Processo sigiloso' : i.l.numeroFormatado} · ${i.descricao} · ${i.data}`);
  }
  if (maisTexto) texto.push(maisTexto);
  if (urlAtualizacoes) texto.push('', `Ver atualizações: ${urlAtualizacoes}`);
  texto.push(
    '',
    urlPreferencias ? `${motivo} Preferências: ${urlPreferencias}` : motivo,
  );

  // ---------- HTML ----------
  const c = CORES_DO_EMAIL.claro;
  const linhasHtml = itens
    .map((i) => {
      const quem = i.l.sigiloso
        ? '<strong>Processo sigiloso</strong>'
        : urlBase
          ? `<a href="${escapar(`${urlBase}/?processo=${i.l.numero}`)}" class="pv-link" style="color:${c.link};font-weight:700;text-decoration:underline;white-space:nowrap">${escapar(i.l.numeroFormatado)}</a>`
          : `<strong style="white-space:nowrap">${escapar(i.l.numeroFormatado)}</strong>`;
      return (
        `<tr><td class="pv-linha" style="padding:10px 0;border-top:1px solid ${c.linha};font-size:15px;line-height:22px">` +
        `${quem}<br><span class="pv-sub" style="color:${c.tinta2};font-size:14px">${escapar(i.descricao)} · ${i.data}</span></td></tr>`
      );
    })
    .join('');
  const maisHtml = maisTexto
    ? `<tr><td class="pv-linha" style="padding:10px 0;border-top:1px solid ${c.linha};font-size:15px;line-height:22px">${maisTexto}</td></tr>`
    : '';
  const botao = urlAtualizacoes
    ? `<tr><td style="padding:18px 0 6px"><a href="${escapar(urlAtualizacoes)}" class="pv-botao" style="display:inline-block;background:${c.botao};color:${c.botaoTinta};font-size:16px;font-weight:700;line-height:20px;padding:13px 24px;border-radius:8px;text-decoration:none">Ver atualizações</a></td></tr>` +
      `<tr><td style="font-size:14px;line-height:20px;padding-bottom:6px"><a href="${escapar(urlAtualizacoes)}" class="pv-link" style="color:${c.link}">${escapar(urlAtualizacoes)}</a></td></tr>`
    : '';
  const rodape =
    escapar(motivo) +
    (urlPreferencias
      ? ` <a href="${escapar(urlPreferencias)}" class="pv-link" style="color:${c.link}">Alterar preferências</a>`
      : '');

  const e = CORES_DO_EMAIL.escuro;
  const html =
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' +
    `<title>${escapar(assuntoDoAviso(totalDeProcessos))}</title>` +
    '<style>@media (prefers-color-scheme: dark){' +
    `body,.pv-fundo{background:${e.fundo} !important}` +
    `.pv-papel{background:${e.papel} !important;color:${e.tinta} !important}` +
    `.pv-linha{border-color:${e.linha} !important;color:${e.tinta} !important}` +
    `.pv-sub,.pv-rodape{color:${e.tinta2} !important}` +
    `.pv-link{color:${e.link} !important}` +
    `.pv-botao{background:${e.botao} !important;color:${e.botaoTinta} !important}` +
    '}</style></head>' +
    `<body style="margin:0;padding:0;background:${c.fundo}">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="pv-fundo" style="background:${c.fundo}"><tr><td align="center" style="padding:16px 8px">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="pv-papel" style="max-width:600px;background:${c.papel};color:${c.tinta};border-radius:10px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif"><tr><td style="padding:20px 20px 16px">` +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0">' +
    `<tr><td style="font-size:18px;line-height:24px;font-weight:700;padding-bottom:6px">Processo Vivo</td></tr>` +
    `<tr><td style="font-size:16px;line-height:24px;padding-bottom:10px">${escapar(abertura)}</td></tr>` +
    `${linhasHtml}${maisHtml}${botao}` +
    `<tr><td class="pv-rodape" style="color:${c.tinta2};font-size:14px;line-height:20px;padding-top:14px;border-top:1px solid ${c.linha}">${rodape}</td></tr>` +
    '</table></td></tr></table></td></tr></table></body></html>';

  return {
    assunto: assuntoDoAviso(totalDeProcessos),
    texto: texto.join('\n'),
    html,
  };
}

function descricaoDaLinha(l: LinhaDoAviso): string {
  // Sigilo: nem o tipo do ato sai do sistema. O console mostra rótulo e data,
  // mas o e-mail é o canal que menos controlamos.
  if (l.sigiloso) return 'nova movimentação';
  const base = descricaoDoAto(l.tipo).trim() || 'Atualização';
  const curto = base.length <= LIMITE_DO_TIPO ? base : `${base.slice(0, LIMITE_DO_TIPO - 1)}…`;
  if (!l.etiqueta) return curto;
  // "Intimação" + etiqueta "Intimação" seria a mesma palavra duas vezes.
  return semAcento(curto).includes(semAcento(l.etiqueta)) ? curto : `${curto} (${l.etiqueta})`;
}

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function formatarData(d: Date): string {
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function escapar(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
