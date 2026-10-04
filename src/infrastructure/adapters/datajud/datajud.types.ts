import { z } from 'zod';

/**
 * Contrato de entrada do DataJud, validado com Zod na borda.
 *
 * Validar aqui (e não confiar em `as`) é o que impede que uma mudança silenciosa
 * no payload do CNJ vire `undefined` circulando pelo domínio até estourar três
 * camadas acima, longe da causa. O que não bate vira `RespostaInvalidaError`,
 * que o orquestrador entende e usa para acionar o fallback.
 *
 * `.passthrough()` porque o CNJ adiciona campos sem aviso — campo novo não deve
 * quebrar a consulta; campo com tipo trocado deve.
 */

const itemTabelado = z
  .object({
    codigo: z.number().optional(),
    nome: z.string().optional(),
  })
  .passthrough();

const complementoTabelado = z
  .object({
    codigo: z.number().optional(),
    valor: z.number().optional(),
    nome: z.string().optional(),
    descricao: z.string().optional(),
  })
  .passthrough();

export const movimentoDataJudSchema = z
  .object({
    codigo: z.number().optional(),
    nome: z.string().optional(),
    dataHora: z.string().optional(),
    complementosTabelados: z.array(complementoTabelado).optional(),
  })
  .passthrough();

export const orgaoJulgadorSchema = z
  .object({
    codigo: z.number().optional(),
    nome: z.string().optional(),
    codigoMunicipioIBGE: z.number().optional(),
  })
  .passthrough();

export const processoDataJudSchema = z
  .object({
    numeroProcesso: z.string(),
    tribunal: z.string().optional(),
    grau: z.string().optional(),
    dataAjuizamento: z.string().optional(),
    dataHoraUltimaAtualizacao: z.string().optional(),
    nivelSigilo: z.number().optional(),
    classe: itemTabelado.optional(),
    assuntos: z.array(itemTabelado).optional(),
    orgaoJulgador: orgaoJulgadorSchema.optional(),
    movimentos: z.array(movimentoDataJudSchema).optional(),
    formato: itemTabelado.optional(),
    sistema: itemTabelado.optional(),
  })
  .passthrough();

export const respostaDataJudSchema = z
  .object({
    hits: z.object({
      total: z
        .object({ value: z.number(), relation: z.string().optional() })
        .optional(),
      hits: z.array(
        z.object({
          _id: z.string().optional(),
          _source: processoDataJudSchema,
        }),
      ),
    }),
  })
  .passthrough();

export type ProcessoDataJud = z.infer<typeof processoDataJudSchema>;
export type RespostaDataJud = z.infer<typeof respostaDataJudSchema>;
export type MovimentoDataJud = z.infer<typeof movimentoDataJudSchema>;
