import { chaveDaMovimentacao } from '../../domain/entities/Acompanhamento.js';
import { atoDoDiario } from '../../domain/entities/atoDoDiario.js';
import {
  dataBrasileira,
  dataLocalEm,
  ehDataLocalValida,
  LIMITE_OBSERVACAO,
  type EventoDeCalendario,
} from '../../domain/entities/EventoDeCalendario.js';
import {
  calcularPrazo,
  tituloDoPrazoCalculado,
  type PrazoCalculado,
  type TipoDePrazo,
} from '../../domain/entities/prazoEmDias.js';
import {
  AnaliseNaoEncontradaError,
  AcompanhamentoNaoEncontradoError,
  EventoDeCalendarioInvalidoError,
  PrazoNaoCalculavelError,
} from '../../domain/errors/index.js';
import type { RepositorioAcompanhamentos } from '../../domain/ports/RepositorioAcompanhamentos.js';
import type { RepositorioAnalises } from '../../domain/ports/RepositorioAnalises.js';
import type { ServicoCalendario } from './ServicoCalendario.js';

/**
 * "Criar aviso no calendário" a partir de uma análise por IA (v0.39.0).
 *
 * Duas operações, e a primeira NÃO GRAVA NADA:
 *
 *  - `previa`: recalcula no servidor e devolve a data com as premissas e o aviso "a conferir";
 *  - `confirmar`: recalcula DE NOVO, valida a data (a calculada ou uma editada pelo advogado) e
 *    só então cria o evento. Sem esse segundo passo, nenhum evento nasce.
 *
 * Este serviço NÃO tem analisador: não existe caminho daqui até o modelo (as duas rotas fazem
 * zero chamadas, e há teste). A IA só entregou o NÚMERO de dias, que `verificarAnalise` já
 * conferiu contra o texto; a data é conta do `prazoEmDias.ts`. O termo inicial vem do ato no
 * retrato da PRÓPRIA conta, e só vale para ato do Diário (que tem a data de disponibilização).
 *
 * O título do evento sai de campos estruturados (dias e tipo): nada do texto da IA, nenhum nome
 * de parte. E o feed ICS já nunca leva título, observação nem trecho.
 */

export interface OpcoesServicoAvisoDoPrazo {
  readonly analises: RepositorioAnalises;
  readonly repositorio: RepositorioAcompanhamentos;
  readonly calendario: ServicoCalendario;
  /** A mesma regra do plano IA da análise. */
  readonly exigirPlanoIa: (workspace: string) => Promise<void>;
  /** O recurso `calendario` do plano. */
  readonly exigirCalendario: (workspace: string) => Promise<void>;
}

export interface EscolhaDoAviso {
  /** Só vale quando o ato não disse se os dias são úteis ou corridos. */
  readonly tipo?: TipoDePrazo;
}

export interface PreviaDoAviso extends PrazoCalculado {
  readonly analiseId: string;
  readonly dias: number;
  readonly tipo: TipoDePrazo;
  /** O ato dizia o tipo? `false` = foi o advogado quem escolheu. */
  readonly tipoDoAto: boolean;
  readonly titulo: string;
}

export class ServicoAvisoDoPrazo {
  constructor(private readonly o: OpcoesServicoAvisoDoPrazo) {}

  /** Não grava nada. */
  async previa(
    workspace: string,
    analiseId: string,
    escolha: EscolhaDoAviso = {},
  ): Promise<PreviaDoAviso> {
    const { previa } = await this.montar(workspace, analiseId, escolha);
    return previa;
  }

  async confirmar(
    workspace: string,
    analiseId: string,
    escolha: EscolhaDoAviso & { readonly dataLocal?: string } = {},
  ): Promise<EventoDeCalendario> {
    // Recalcula: o que o navegador viu na prévia não é fonte de nada aqui.
    const { previa, numero, doDia, analiseEm } = await this.montar(
      workspace,
      analiseId,
      escolha,
    );
    const dataLocal = escolha.dataLocal ?? previa.dataFinal;
    if (!ehDataLocalValida(dataLocal)) {
      throw new EventoDeCalendarioInvalidoError('Informe a data como AAAA-MM-DD.');
    }
    const editada = dataLocal !== previa.dataFinal;
    const observacao = [
      ...previa.premissas,
      `Data calculada: ${dataBrasileira(previa.dataFinal)}.`,
      editada
        ? `Data editada por você para ${dataBrasileira(dataLocal)}.`
        : 'Data a conferir no processo.',
      `Origem: ato do Diário disponibilizado em ${dataBrasileira(doDia)}; análise por IA de ${dataBrasileira(analiseEm)}.`,
    ]
      .join('\n')
      .slice(0, LIMITE_OBSERVACAO);

    return this.o.calendario.criarManual(workspace, {
      numeroProcesso: numero,
      tipo: 'prazo',
      titulo: previa.titulo,
      dataLocal,
      observacao,
      // O marcador só vale enquanto a data é a calculada: editada, o feed não pode dizer isso.
      ...(editada ? {} : { calculado: true }),
    });
  }

  private async montar(
    workspace: string,
    analiseId: string,
    escolha: EscolhaDoAviso,
  ): Promise<{
    previa: PreviaDoAviso;
    numero: string;
    doDia: string;
    analiseEm: string;
  }> {
    await this.o.exigirPlanoIa(workspace);
    await this.o.exigirCalendario(workspace);

    const analise = await this.o.analises.buscar(workspace, analiseId);
    if (!analise) throw new AnaliseNaoEncontradaError();
    const resultado = analise.resultado;
    if (resultado.estado !== 'verificada' || !resultado.prazo) {
      throw new PrazoNaoCalculavelError(
        'sem_prazo_na_analise',
        'Esta análise não traz um prazo em dias escrito no ato. Crie o aviso manualmente no calendário.',
      );
    }

    const pasta = await this.o.repositorio.buscar(workspace, analise.numero);
    if (!pasta) throw new AcompanhamentoNaoEncontradoError();
    const ato = pasta.processo?.movimentacoes.find(
      (m) => chaveDaMovimentacao(m) === analise.chaveDoAto,
    );
    if (!ato) {
      throw new PrazoNaoCalculavelError(
        'ato_nao_encontrado',
        'Esse ato não está mais no último retrato do processo. Atualize a tela e confira de novo.',
      );
    }
    if (!atoDoDiario(ato)) {
      throw new PrazoNaoCalculavelError(
        'ato_fora_do_diario',
        'O prazo só é calculado para ato publicado no Diário. Crie o aviso manualmente no calendário.',
      );
    }

    // Sem tipo padrão: ou o ato disse, ou o advogado escolheu.
    const tipoDoAto = resultado.prazo.tipo !== null;
    const tipo = resultado.prazo.tipo ?? escolha.tipo;
    if (!tipo) {
      throw new PrazoNaoCalculavelError(
        'tipo_necessario',
        'O ato não diz se os dias são úteis ou corridos. Escolha uma opção para calcular.',
      );
    }

    const doDia = dataLocalEm(ato.data);
    const calculado = calcularPrazo({
      disponibilizacao: doDia,
      dias: resultado.prazo.dias,
      tipo,
    });
    return {
      numero: analise.numero,
      doDia,
      analiseEm: dataLocalEm(analise.procedencia.criadaEm),
      previa: {
        ...calculado,
        analiseId: analise.id,
        dias: resultado.prazo.dias,
        tipo,
        tipoDoAto,
        titulo: tituloDoPrazoCalculado(resultado.prazo.dias, tipo),
      },
    };
  }
}
