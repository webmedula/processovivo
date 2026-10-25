import {
  ROTULO_DA_FUNCAO,
  FUNCOES_DE_IA,
  type FuncaoDeIa,
} from '../../../domain/entities/ControleDaIa.js';
import {
  FRASE_DA_RESSALVA,
  FRASE_DO_BLOQUEIO,
  MOTIVOS_DE_APROVACAO,
  PALAVRA_DE_CONFIRMACAO,
  REGRAS_DE_PUBLICACAO,
  ROTULO_DO_MOTIVO_DE_APROVACAO,
  TAMANHO_MAXIMO_DA_OBSERVACAO,
  impactoPorDiaUsd,
  linhasDaComparacao,
  type CatalogoDeModelos,
  type ItemDoCatalogo,
} from '../../../domain/entities/ModelosDeIa.js';
import type { TesteDeModelo } from '../../../domain/ports/ModelosDeIa.js';
import {
  MENSAGEM_DO_MODELO_RECUSADO,
  type ServicoModelosDeIa,
} from '../../../application/services/ServicoModelosDeIa.js';
import {
  FRASE_DA_FALHA_DO_TESTE,
  type ServicoTesteDeModelo,
} from '../../../application/services/ServicoTesteDeModelo.js';
import { AVISO_DE_NOVO_MODELO } from '../../../infrastructure/ia/modelos-permitidos.js';

/**
 * As respostas do painel de modelos (Fase B) como JSON. SÓ ids de modelo, números, datas e frases FIXAS
 * nossas: nenhum texto de fixture, de ato, de peça ou de resposta do modelo existe neste contrato.
 */

const iso = (d: Date | undefined): string | null => (d ? d.toISOString() : null);

function apelidoDe(catalogo: CatalogoDeModelos, id: string): string {
  return catalogo.buscar(id)?.apelido ?? id;
}

function itemParaJson(i: ItemDoCatalogo): Record<string, unknown> {
  return {
    id: i.id,
    apelido: i.apelido,
    provedor: i.provedor,
    precoEntradaPorMTokens: i.precoEntradaPorMTokens,
    precoSaidaPorMTokens: i.precoSaidaPorMTokens,
    janelaContexto: i.janelaContexto,
    zdrConfirmadoEm: i.zdrConfirmadoEm,
    zdrFonte: i.zdrFonte,
  };
}

export function testeParaJson(
  t: TesteDeModelo,
  catalogo: CatalogoDeModelos,
  volumeNosUltimosDias: number,
): Record<string, unknown> {
  const mc = t.metricasDoCandidato;
  const mr = t.metricasDaReferencia;
  return {
    id: t.id,
    funcao: t.funcao,
    candidato: t.candidato,
    candidatoApelido: apelidoDe(catalogo, t.candidato),
    referencia: t.referencia,
    referenciaApelido: apelidoDe(catalogo, t.referencia),
    estado: t.estado,
    criadoEm: t.criadoEm.toISOString(),
    iniciadoEm: iso(t.iniciadoEm),
    terminadoEm: iso(t.terminadoEm),
    chamadasPrevistas: t.chamadasPrevistas,
    chamadasFeitas: Math.min(t.chamadasFeitas, t.chamadasPrevistas),
    estimativaUsd: t.estimativaUsd,
    gastoUsd: t.gastoUsd,
    veredito: t.veredito ?? null,
    bloqueios: t.bloqueios.map((c) => ({ codigo: c, frase: FRASE_DO_BLOQUEIO[c] })),
    ressalvas: t.ressalvas.map((c) => ({ codigo: c, frase: FRASE_DA_RESSALVA[c] })),
    falha: t.falha ? { codigo: t.falha, frase: FRASE_DA_FALHA_DO_TESTE[t.falha] } : null,
    comparacao: mc && mr ? linhasDaComparacao(mc, mr) : null,
    analisesNosUltimos30Dias: volumeNosUltimosDias,
    impactoPorDiaUsd: mc && mr ? impactoPorDiaUsd(mc, mr, volumeNosUltimosDias) : null,
  };
}

export function modelosParaJson(
  modelos: ServicoModelosDeIa,
  testes: ServicoTesteDeModelo,
): Record<string, unknown> {
  const catalogo = modelos.catalogo;
  const grav = modelos.gravados();
  const andamento = testes.emAndamento();
  return {
    testeDisponivel: testes.disponivel,
    aviso: AVISO_DE_NOVO_MODELO,
    regras: {
      ...REGRAS_DE_PUBLICACAO,
      tetoDaRodadaUsd: testes.teto,
      palavraDeConfirmacao: PALAVRA_DE_CONFIRMACAO,
      tamanhoMaximoDaObservacao: TAMANHO_MAXIMO_DA_OBSERVACAO,
      motivosDeAprovacao: MOTIVOS_DE_APROVACAO.map((m) => ({
        codigo: m,
        rotulo: ROTULO_DO_MOTIVO_DE_APROVACAO[m],
      })),
    },
    emAndamento: andamento
      ? testeParaJson(andamento, catalogo, modelos.volumeRecente(andamento.funcao))
      : null,
    funcoes: FUNCOES_DE_IA.map((f: FuncaoDeIa) => {
      const e = modelos.efetivo(f);
      const g = grav[f];
      const ultimo = testes.ultimoDaFuncao(f);
      const sit = modelos.situacaoDaPublicacao(f, ultimo);
      const volume = ultimo ? modelos.volumeRecente(f) : 0;
      return {
        funcao: f,
        rotulo: ROTULO_DA_FUNCAO[f],
        efetivo: {
          modelo: e.modelo,
          apelido: apelidoDe(catalogo, e.modelo),
          origem: e.origem,
          painelInvalido: e.painelInvalido,
          desde: e.origem === 'painel' ? iso(g.desde ?? undefined) : null,
        },
        anterior:
          g.modelo !== null && g.anterior !== null
            ? { modelo: g.anterior, apelido: apelidoDe(catalogo, g.anterior) }
            : null,
        podeReverter: modelos.podeReverter(f),
        candidatos: modelos.candidatos(f).map(itemParaJson),
        ultimoTeste: ultimo ? testeParaJson(ultimo, catalogo, volume) : null,
        publicacao: sit.pode
          ? { pode: true, exigeAprovacao: sit.exigeAprovacao }
          : {
              pode: false,
              motivo: sit.motivo,
              mensagem: MENSAGEM_DO_MODELO_RECUSADO[sit.motivo],
            },
      };
    }),
  };
}
