import { MOTIVOS_DA_AVALIACAO } from '../../domain/entities/AnaliseDoAto.js';
import { ehFuncaoDeIa, type FuncaoDeIa } from '../../domain/entities/ControleDaIa.js';
import {
  lerVersaoEfetiva,
  rotuloDaVersaoEfetiva,
} from '../../domain/entities/InstrucoesDeIa.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { LeitorDeErrosDeIa } from '../../domain/ports/InstrucoesDeIa.js';
import type { LeitorDeUsoDeIa } from '../../domain/ports/PainelDeIa.js';
import { recusarInstrucao, type ServicoInstrucoesDeIa } from './ServicoInstrucoesDeIa.js';

export const ROTULO_DO_MOTIVO_DO_POLEGAR: Readonly<Record<string, string>> =
  Object.freeze({
    erro_de_fato: 'erro de fato',
    citacao_inventada: 'citação inventada',
    concluiu_prazo: 'concluiu prazo',
    deixou_de_fora: 'deixou de fora algo importante',
    pode_causar_prejuizo: 'pode causar prejuízo',
    outro: 'outro',
  });

export const DIAS_DOS_ERROS = 30;
export const MAXIMO_DE_ERROS_RECENTES = 30;

export interface PolegaresDaEdicao {
  readonly edicao: number;
  /** `ato-1.2.0+e0` → `+e0` (a versão de instruções, sem o prompt de código). */
  readonly rotulo: string;
  readonly analises: number;
  readonly uteis: number;
  readonly erradas: number;
  readonly perigosas: number;
  readonly semAvaliacao: number;
  readonly naoVerificadas: number;
}

export interface ErroParaATela {
  readonly em: Date;
  readonly versao: string;
  readonly avaliacao: 'errado' | 'perigoso';
  readonly motivo: string | null;
  readonly motivoRotulo: string | null;
  readonly modelo: string;
  readonly naoVerificada: boolean;
  readonly conta: string;
}

export interface ErrosDaFuncao {
  readonly funcao: FuncaoDeIa;
  readonly dias: number;
  /** A edição em produção agora e os polegares que ela já recebeu. */
  readonly atual: PolegaresDaEdicao;
  /** Todas as edições com análise no período, a mais nova primeiro. */
  readonly porEdicao: readonly PolegaresDaEdicao[];
  readonly recentes: readonly ErroParaATela[];
}

/**
 * "Onde a IA erra" (Fase C, v0.61.0): os polegares das últimas análises por EDIÇÃO das instruções, para o
 * operador ver o que ajustar. Lê as mesmas tabelas da Fase A, sem o conteúdo da análise: só a data, a versão
 * (`ato-1.2.0+e1`), o polegar, o motivo de lista fechada, o modelo e os 8 primeiros caracteres da conta.
 */
export class ServicoErrosDeInstrucoes {
  constructor(
    private readonly o: {
      readonly leitor: Pick<LeitorDeUsoDeIa, 'linhas'>;
      readonly erros: LeitorDeErrosDeIa;
      readonly instrucoes: Pick<ServicoInstrucoesDeIa, 'efetiva'>;
      readonly clock: Clock;
    },
  ) {}

  consultar(funcao: string, dias: number = DIAS_DOS_ERROS): ErrosDaFuncao {
    if (!ehFuncaoDeIa(funcao)) throw recusarInstrucao('funcao_desconhecida');
    const desde = new Date(this.o.clock.agora().getTime() - dias * 86_400_000);
    const porEdicao = new Map<number, Omit<PolegaresDaEdicao, 'rotulo'>>();
    for (const l of this.o.leitor.linhas(funcao, desde)) {
      const edicao = lerVersaoEfetiva(l.versaoPrompt).edicao;
      const c = porEdicao.get(edicao) ?? {
        edicao,
        analises: 0,
        uteis: 0,
        erradas: 0,
        perigosas: 0,
        semAvaliacao: 0,
        naoVerificadas: 0,
      };
      porEdicao.set(edicao, {
        ...c,
        analises: c.analises + 1,
        uteis: c.uteis + (l.avaliacao === 'util' ? 1 : 0),
        erradas: c.erradas + (l.avaliacao === 'errado' ? 1 : 0),
        perigosas: c.perigosas + (l.avaliacao === 'perigoso' ? 1 : 0),
        semAvaliacao: c.semAvaliacao + (l.avaliacao === null ? 1 : 0),
        naoVerificadas: c.naoVerificadas + (l.naoVerificada ? 1 : 0),
      });
    }
    const comRotulo = (c: Omit<PolegaresDaEdicao, 'rotulo'>): PolegaresDaEdicao => ({
      ...c,
      rotulo: `+e${c.edicao}`,
    });
    const lista = [...porEdicao.values()]
      .sort((a, b) => b.edicao - a.edicao)
      .map(comRotulo);
    const vigente = this.o.instrucoes.efetiva(funcao).versao;
    const atual =
      lista.find((e) => e.edicao === vigente) ??
      comRotulo({
        edicao: vigente,
        analises: 0,
        uteis: 0,
        erradas: 0,
        perigosas: 0,
        semAvaliacao: 0,
        naoVerificadas: 0,
      });
    const recentes = this.o.erros
      .errosRecentes(funcao, desde, MAXIMO_DE_ERROS_RECENTES)
      .map((e): ErroParaATela => ({
        em: e.em,
        versao: rotuloDaVersaoEfetiva(e.versaoPrompt),
        avaliacao: e.avaliacao,
        motivo: e.motivo,
        motivoRotulo:
          e.motivo && (MOTIVOS_DA_AVALIACAO as readonly string[]).includes(e.motivo)
            ? (ROTULO_DO_MOTIVO_DO_POLEGAR[e.motivo] ?? null)
            : null,
        modelo: e.modelo,
        naoVerificada: e.naoVerificada,
        conta: e.conta,
      }));
    return { funcao, dias, atual, porEdicao: lista, recentes };
  }
}
