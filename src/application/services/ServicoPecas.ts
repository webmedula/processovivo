import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import { herdarOrigemPorMovimento } from '../../domain/entities/Peca.js';
import type { ConteudoPeca, Peca } from '../../domain/entities/Peca.js';
import type { Movimentacao } from '../../domain/entities/Movimentacao.js';
import { CredencialTribunalInvalidaError } from '../../domain/errors/index.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type {
  CredencialCadastrada,
  RepositorioCredenciais,
} from '../../domain/ports/RepositorioCredenciais.js';
import type {
  AtosDoProcesso,
  CredencialTribunal,
} from '../../domain/ports/ProvedorDePecas.js';
import type { BaixarPecaDoProcesso } from '../../domain/usecases/BaixarPecaDoProcesso.js';
import type { ListarPecasDoProcesso } from '../../domain/usecases/ListarPecasDoProcesso.js';
import type { BuscarProcessoPorNumero } from '../../domain/usecases/BuscarProcessoPorNumero.js';
import type {
  PecaBaixada,
  RepositorioPecasBaixadas,
} from '../../domain/ports/RepositorioPecasBaixadas.js';
import {
  batizarPeloCodigo,
  montarLinhaDoTempo,
} from '../../domain/entities/linhaDoTempo.js';
import type { Parte } from '../../domain/entities/Parte.js';
import type { LinhaDoTempo } from '../../domain/entities/linhaDoTempo.js';

export interface OpcoesServicoPecas {
  readonly listar: ListarPecasDoProcesso;
  readonly baixar: BaixarPecaDoProcesso;
  readonly credenciais: RepositorioCredenciais;
  readonly logger: Logger;
  /**
   * Opcional, e só para a régua temporal: é daqui que saem os andamentos das
   * fontes públicas que o tribunal não cobriu. Sem ele a régua é montada só com
   * o que o tribunal mandou — completa quanto ao tribunal, e sem as publicações
   * do DJEN que ele não numera.
   */
  readonly processos?: BuscarProcessoPorNumero;
  /**
   * Histórico de downloads. Opcional: sem ele o download funciona igual e só
   * não fica registrado — uma instalação sem banco não pode perder a peça por
   * causa do contador da tela.
   */
  readonly baixadas?: RepositorioPecasBaixadas;
  /**
   * Chamado com o que o tribunal acabou de listar (v0.33.0). É como a Pasta
   * digital fica sabendo das peças sem consultar o tribunal de novo. Falha
   * aqui nunca derruba a listagem.
   */
  readonly aoListar?: (
    workspace: string,
    numeroProcesso: string,
    atos: AtosDoProcesso,
  ) => Promise<void>;
}

/**
 * Orquestra o acesso às peças e mantém o ESTADO da credencial.
 *
 * Os casos de uso não fazem isso porque não é regra de negócio: saber que uma
 * credencial foi aceita ou recusada é informação operacional, que existe para
 * uma pessoa poder agir. E ela precisa existir por uma razão concreta — a
 * vigilância roda sozinha, de hora em hora, sem ninguém olhando. Quando a senha
 * do advogado no tribunal muda (e ela muda, por política de expiração), o que
 * acontece sem esta marcação é: a varredura passa a falhar em silêncio, o
 * advogado continua recebendo e-mail de "nada novo", e a primeira notícia do
 * problema é um prazo perdido.
 */
export class ServicoPecas {
  private readonly listar: ListarPecasDoProcesso;
  private readonly baixar: BaixarPecaDoProcesso;
  private readonly credenciais: RepositorioCredenciais;
  private readonly logger: Logger;
  private readonly processos: BuscarProcessoPorNumero | undefined;
  private readonly baixadas: RepositorioPecasBaixadas | undefined;
  private readonly aoListar: OpcoesServicoPecas['aoListar'];

  constructor(opcoes: OpcoesServicoPecas) {
    this.listar = opcoes.listar;
    this.baixar = opcoes.baixar;
    this.credenciais = opcoes.credenciais;
    this.logger = opcoes.logger.child({ servico: 'pecas' });
    this.processos = opcoes.processos;
    this.baixadas = opcoes.baixadas;
    this.aoListar = opcoes.aoListar;
  }

  /**
   * A régua temporal: um evento por ato, cada um já com os seus documentos.
   *
   * A consulta às fontes públicas roda em paralelo com a do tribunal e o
   * fracasso dela NÃO derruba a resposta: a régua do MNI sozinha já é mais
   * completa do que a tela anterior, e trocar isso por um erro porque o DataJud
   * oscilou seria piorar o que funciona por causa do que enfeita.
   */
  async linhaDoTempoDoProcesso(
    workspace: string,
    numeroProcesso: string,
  ): Promise<LinhaDoTempo> {
    return (await this.reguaDoProcesso(workspace, numeroProcesso)).linha;
  }

  /**
   * A régua e, da MESMA resposta do tribunal, as partes como estão nos autos (v0.71.0). Sem
   * consulta a mais: o cabeçalho já vinha na listagem. `partes` vazio = o tribunal não trouxe
   * cabeçalho com partes, e a tela fica com as que já tinha.
   */
  async reguaDoProcesso(
    workspace: string,
    numeroProcesso: string,
  ): Promise<{ linha: LinhaDoTempo; partes: readonly Parte[] }> {
    const [atos, publicas] = await Promise.all([
      this.listarDoProcesso(workspace, numeroProcesso),
      this.movimentacoesPublicas(numeroProcesso),
    ]);

    return {
      linha: montarLinhaDoTempo({
        movimentacoes: publicas,
        movimentosDoTribunal: batizarPeloCodigo(atos.movimentos, publicas),
        pecas: atos.pecas,
      }),
      partes: atos.partes,
    };
  }

  private async movimentacoesPublicas(
    numeroProcesso: string,
  ): Promise<readonly Movimentacao[]> {
    if (!this.processos) return [];
    try {
      const processo = await this.processos.executar({ numeroProcesso });
      return processo.movimentacoes;
    } catch (erro) {
      this.logger.debug('régua montada sem as fontes públicas', {
        numeroProcesso,
        motivo: erro instanceof Error ? erro.message : 'desconhecido',
      });
      return [];
    }
  }

  /**
   * As peças do processo e os movimentos que vieram na mesma resposta.
   *
   * Os dois juntos porque é assim que o tribunal responde — e porque separá-los
   * em duas chamadas custaria uma segunda consulta de dezenas de segundos para
   * montar uma única tela. Os movimentos são o que permite entregar cada
   * documento na linha do evento que o juntou, em vez de numa lista no rodapé.
   */
  async listarDoProcesso(
    workspace: string,
    numeroProcesso: string,
  ): Promise<{
    pecas: Peca[];
    movimentos: readonly Movimentacao[];
    partes: readonly Parte[];
  }> {
    const atos = await this.registrando(workspace, numeroProcesso, () =>
      this.listar.executar({ workspace, numeroProcesso }),
    );
    try {
      await this.aoListar?.(workspace, numeroProcesso, atos);
    } catch (erro) {
      this.logger.warn('listagem entregue, mas o registro da pasta falhou', {
        erro: erro instanceof Error ? erro.message : String(erro),
      });
    }
    // A dedução por movimento é sobre o CONJUNTO, não sobre uma peça — por isso
    // acontece aqui e não no mapper, que monta uma de cada vez.
    return {
      pecas: herdarOrigemPorMovimento(atos.pecas),
      movimentos: atos.movimentos,
      partes: atos.partes ?? [],
    };
  }

  async baixarPeca(
    workspace: string,
    numeroProcesso: string,
    idPeca: string,
  ): Promise<ConteudoPeca> {
    const conteudo = await this.registrando(workspace, numeroProcesso, () =>
      this.baixar.executar({ workspace, numeroProcesso, idPeca }),
    );

    /*
     * O registro acontece DEPOIS do sucesso e nunca derruba o download.
     *
     * A peça já está nas mãos de quem pediu; falhar aqui por causa do banco
     * transformaria um download concluído numa tela de erro, e a pessoa
     * tentaria de novo — outra consulta de dezenas de segundos contra a conta
     * dela no tribunal, para conseguir o que já tinha conseguido.
     */
    try {
      const numero = NumeroCNJ.tentarCriar(numeroProcesso)?.digitos ?? numeroProcesso;
      const registro: PecaBaixada = {
        workspace,
        numeroProcesso: numero,
        idPeca,
        rotulo: conteudo.nomeArquivo || idPeca,
        ...(conteudo.mimetype ? { mimetype: conteudo.mimetype } : {}),
        bytes: conteudo.bytes.length,
        baixadaEm: new Date(),
      };
      await this.baixadas?.registrar(registro);
    } catch (erro) {
      this.logger.warn('não foi possível registrar a peça baixada', {
        workspace,
        motivo: erro instanceof Error ? erro.message : 'desconhecido',
      });
    }

    return conteudo;
  }

  /** O que já foi puxado — do workspace inteiro ou de um processo só. */
  async historicoDeBaixas(
    workspace: string,
    opcoes: { readonly numeroProcesso?: string; readonly limite?: number } = {},
  ): Promise<PecaBaixada[]> {
    if (!this.baixadas) return [];
    const numero = opcoes.numeroProcesso
      ? (NumeroCNJ.tentarCriar(opcoes.numeroProcesso)?.digitos ?? opcoes.numeroProcesso)
      : undefined;
    return this.baixadas.listar(workspace, {
      ...(numero ? { numeroProcesso: numero } : {}),
      ...(opcoes.limite !== undefined ? { limite: opcoes.limite } : {}),
    });
  }

  async baixadasDesde(workspace: string, desde: Date): Promise<number> {
    return this.baixadas ? this.baixadas.contarDesde(workspace, desde) : 0;
  }

  /** Ids já puxados deste processo — a marca de "já baixado" na régua. */
  async idsJaBaixados(workspace: string, numeroProcesso: string): Promise<string[]> {
    if (!this.baixadas) return [];
    const numero = NumeroCNJ.tentarCriar(numeroProcesso)?.digitos ?? numeroProcesso;
    return this.baixadas.idsDoProcesso(workspace, numero);
  }

  async listarCredenciais(workspace: string): Promise<CredencialCadastrada[]> {
    return this.credenciais.listar(workspace);
  }

  async cadastrarCredencial(
    workspace: string,
    credencial: CredencialTribunal,
  ): Promise<CredencialCadastrada> {
    const cadastrada = await this.credenciais.salvar(workspace, credencial);
    // Identificação (o CPF do consultante) NÃO entra no log: é dado pessoal e
    // não ajuda a diagnosticar nada que o tribunal e o workspace já não digam.
    this.logger.info('credencial de tribunal cadastrada', {
      workspace,
      tribunal: cadastrada.tribunal,
    });
    return cadastrada;
  }

  async removerCredencial(workspace: string, tribunal: string): Promise<boolean> {
    return this.credenciais.remover(workspace, tribunal);
  }

  /**
   * Roda a operação e anota o veredito do tribunal sobre a credencial.
   *
   * O `catch` re-lança sempre: marcar a recusa não é tratar o erro. Engolir aqui
   * faria a rota devolver lista vazia de peças com HTTP 200 — o pior desfecho
   * possível, porque "não há peças" e "sua senha está errada" viram a mesma tela.
   */
  private async registrando<T>(
    workspace: string,
    numeroProcesso: string,
    operacao: () => Promise<T>,
  ): Promise<T> {
    const tribunal = NumeroCNJ.tentarCriar(numeroProcesso)?.siglaTribunal;

    try {
      const resultado = await operacao();
      if (tribunal) await this.credenciais.registrarUso(workspace, tribunal);
      return resultado;
    } catch (erro) {
      if (erro instanceof CredencialTribunalInvalidaError && tribunal) {
        await this.credenciais.registrarRecusa(workspace, tribunal);
        this.logger.warn('credencial recusada pelo tribunal', {
          workspace,
          tribunal,
          acao: 'o assinante precisa atualizar usuário e senha',
        });
      }
      throw erro;
    }
  }
}
