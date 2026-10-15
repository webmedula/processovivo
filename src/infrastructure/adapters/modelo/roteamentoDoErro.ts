import { sanearCorpoEnviado } from './diagnosticoDeChamada.js';

/**
 * O que o corpo de erro do OpenRouter diz sobre ONDE o roteamento parou: `failed_routing_step`
 * (o passo) e `routing_funnel` (o funil: quantos endpoints sobraram em cada filtro). Os nomes dos
 * campos vêm do relato de uma rodada real; o aninhamento exato NÃO foi capturado, por isso a busca
 * é recursiva e tolerante, e o que não for achado fica ausente (nunca inventado).
 */
export interface RoteamentoDoErro {
  readonly passo?: string;
  readonly funil?: unknown;
}

const CAMPO_DO_PASSO = 'failed_routing_step';
const CAMPO_DO_FUNIL = 'routing_funnel';
const PROFUNDIDADE_MAXIMA = 6;

function procurar(
  valor: unknown,
  profundidade: number,
  achados: Map<string, unknown>,
): void {
  if (profundidade > PROFUNDIDADE_MAXIMA) return;
  if (typeof valor === 'string') {
    const t = valor.trim();
    // O OpenRouter às vezes embute o JSON do provedor numa string (`metadata.raw`).
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        procurar(JSON.parse(t), profundidade + 1, achados);
      } catch {
        /* não era JSON */
      }
    }
    return;
  }
  if (Array.isArray(valor)) {
    for (const v of valor) procurar(v, profundidade + 1, achados);
    return;
  }
  if (typeof valor === 'object' && valor !== null) {
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      if ((k === CAMPO_DO_PASSO || k === CAMPO_DO_FUNIL) && !achados.has(k))
        achados.set(k, v);
      procurar(v, profundidade + 1, achados);
    }
  }
}

/** Texto curto e seguro para ir à mensagem e ao terminal: só o token do passo. */
function textoDoPasso(passo: unknown): string | undefined {
  if (passo === undefined || passo === null) return undefined;
  const bruto = typeof passo === 'string' ? passo : JSON.stringify(passo);
  const limpo = bruto
    .replace(/[^\p{L}\p{N}_ .:/-]/gu, '')
    .trim()
    .slice(0, 80);
  return limpo === '' ? undefined : limpo;
}

export function extrairRoteamento(corpo: string): RoteamentoDoErro {
  if (corpo.trim() === '') return {};
  let json: unknown;
  try {
    json = JSON.parse(corpo);
  } catch {
    return {};
  }
  const achados = new Map<string, unknown>();
  procurar(json, 0, achados);
  const passo = textoDoPasso(achados.get(CAMPO_DO_PASSO));
  const funil = achados.get(CAMPO_DO_FUNIL);
  return {
    ...(passo !== undefined ? { passo } : {}),
    ...(funil !== undefined ? { funil: sanearCorpoEnviado(funil) } : {}),
  };
}

/**
 * O passo é o filtro de POLÍTICA DE DADOS (ZDR, retenção, coleta de dados, treino)? Só então a
 * falha é "sem ZDR". O vocabulário exato dos passos não está documentado: a regra casa por
 * palavra e é provisória — passo desconhecido NUNCA vira "sem ZDR", vira "passo X".
 */
export function ehFiltroDePoliticaDeDados(passo: string | undefined): boolean {
  return (
    passo !== undefined &&
    /data.?polic|zdr|retention|privacy|data.?collection|training/i.test(passo)
  );
}

/** O funil em uma linha, truncado, para o terminal. */
export function funilEmTexto(funil: unknown, limite = 600): string {
  if (funil === undefined) return '(ausente)';
  const t = JSON.stringify(funil);
  return t.length > limite ? `${t.slice(0, limite)}…` : t;
}
