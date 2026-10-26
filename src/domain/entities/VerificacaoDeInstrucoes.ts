import {
  julgarTeste,
  type MetricasDoModelo,
  type MotivoDeBloqueio,
  type MotivoDeRessalva,
} from './ModelosDeIa.js';

/**
 * Os avisos do "conjunto de verificação" das instruções (Fase C, v0.61.0). A conta é a MESMA do veredito de
 * troca de modelo (`julgarTeste`: reaproveitada, não copiada), mas aqui o resultado é só informação: **nada
 * bloqueia a publicação** (decisão do dono, v1.1.0 da especificação). As frases são NOSSAS e falam do rascunho
 * contra a instrução publicada, na mesma rodada, com o mesmo modelo.
 */
export type CodigoDeAvisoDeInstrucao = MotivoDeBloqueio | MotivoDeRessalva;

export const FRASE_DO_AVISO_DE_INSTRUCAO: Readonly<
  Record<CodigoDeAvisoDeInstrucao, string>
> = Object.freeze({
  sem_zdr: 'O modelo não tem retenção zero de dados (ZDR) confirmada. Nada foi enviado.',
  teste_incompleto:
    'A verificação ficou incompleta: os números abaixo não são confiáveis.',
  erro_do_provedor: 'O provedor devolveu erro em alguma chamada da verificação.',
  violacao_acima_da_referencia:
    'O rascunho cometeu mais violações (prazo calculado, valor, data ou nome inventado) do que a instrução publicada.',
  citacao_abaixo_do_minimo:
    'A taxa de citação verificada do rascunho ficou abaixo de 95%.',
  citacao_sem_dado: 'Não foi possível medir a citação verificada do rascunho.',
  falhas_de_formato_acima:
    'As falhas de formato do rascunho passaram das da instrução publicada em mais de 2 pontos percentuais.',
  pontos_sem_dado: 'Não foi possível medir os pontos obrigatórios.',
  pontos_queda_acima_do_limite:
    'Os pontos obrigatórios atendidos caíram mais de 3 pontos percentuais em relação à instrução publicada.',
  latencia_sem_dado: 'Não foi possível medir o tempo de resposta.',
  latencia_acima_do_limite:
    'O tempo de resposta p95 do rascunho ficou mais de 30% acima do da instrução publicada.',
  citacao_menor:
    'A citação verificada do rascunho ficou menor que a da instrução publicada (ainda acima de 95%).',
  falhas_de_formato_maiores:
    'Há mais falhas de formato no rascunho que na instrução publicada (até 2 pontos percentuais).',
  pontos_em_queda:
    'Os pontos obrigatórios atendidos caíram um pouco em relação à instrução publicada (até 3 pontos percentuais).',
  latencia_maior:
    'O tempo de resposta p95 do rascunho ficou maior que o da instrução publicada (até 30%).',
  custo_maior:
    'O custo médio por chamada do rascunho ficou maior que o da instrução publicada.',
  custo_nao_medido: 'O custo não pôde ser medido, então não dá para comparar.',
});

export interface AvisoDeInstrucao {
  readonly codigo: CodigoDeAvisoDeInstrucao;
  readonly frase: string;
  /** `grave` = o que, na troca de modelo, bloquearia; aqui só destaca. Nunca impede de publicar. */
  readonly gravidade: 'grave' | 'leve';
}

export function avisosDePiora(
  rascunho: MetricasDoModelo,
  publicada: MetricasDoModelo,
): { readonly avisos: readonly AvisoDeInstrucao[]; readonly semPiora: boolean } {
  const v = julgarTeste(rascunho, publicada);
  const avisos: AvisoDeInstrucao[] = [
    ...v.bloqueios.map((codigo) => ({
      codigo,
      frase: FRASE_DO_AVISO_DE_INSTRUCAO[codigo],
      gravidade: 'grave' as const,
    })),
    ...v.ressalvas.map((codigo) => ({
      codigo,
      frase: FRASE_DO_AVISO_DE_INSTRUCAO[codigo],
      gravidade: 'leve' as const,
    })),
  ];
  return { avisos, semPiora: avisos.length === 0 };
}
