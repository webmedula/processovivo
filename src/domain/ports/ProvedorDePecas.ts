import type { Parte } from '../entities/Parte.js';
import type { ConteudoPeca, Peca } from '../entities/Peca.js';
import type { Movimentacao } from '../entities/Movimentacao.js';

/**
 * A credencial do advogado num tribunal.
 *
 * Chamada de "credencial" e não de "usuário/senha" porque o que ela representa
 * é a HABILITAÇÃO: o tribunal só entrega peça a quem tem procuração nos autos, e
 * é essa identidade que a credencial carrega. Trocá-la troca a carteira inteira
 * de processos visíveis.
 */
export interface CredencialTribunal {
  /** Sigla do tribunal — ex.: "TJGO". */
  readonly tribunal: string;
  /** Identificação do consultante no sistema do tribunal (CPF, no MNI). */
  readonly identificacao: string;
  readonly senha: string;
}

/**
 * PORTA de saída para uma fonte que entrega PEÇAS do processo.
 *
 * Deliberadamente separada de `ProcessoProvider`, e não um método a mais nele.
 * Três razões, todas descobertas antes de escrever a primeira linha do adapter:
 *
 * 1. **Credencial.** `ProcessoProvider` é global e sem dono; uma fonte de peças
 *    responde de forma diferente para cada advogado. Enfiar isso na porta
 *    existente obrigaria todo adapter a carregar um parâmetro que só um usa.
 * 2. **Cache.** `CachedProcessoProvider` guarda por número de processo, sem
 *    workspace na chave. Se a fonte de peças entrasse na cadeia, a resposta
 *    gerada com a credencial de um assinante seria servida ao seguinte. Não é
 *    hipótese: é o comportamento atual do decorator.
 * 3. **Fallback.** A cadeia existe para trocar de fonte quando uma falha. Peça
 *    não tem fonte alternativa — ou o tribunal onde o processo corre entrega,
 *    ou não existe outro lugar de onde tirar.
 *
 * Contrato de erros — implementadores DEVEM lançar tipos do domínio:
 *   - `CredencialTribunalInvalidaError` o tribunal recusou usuário/senha
 *   - `TeorNaoAutorizadoError`          respondeu, mas não liberou o arquivo
 *   - `ProcessoNaoEncontradoError`      não há esse processo na fonte
 *   - `ProviderIndisponivelError`       rede, timeout, 5xx, bloqueio de IP
 *   - `RespostaInvalidaError`           respondeu fora do contrato
 */
export interface ProvedorDePecas {
  /** Identificador estável, usado em log e procedência. Ex.: "mni". */
  readonly nome: string;

  /** Siglas de tribunal atendidas. */
  readonly tribunais: readonly string[];

  /**
   * Metadado das peças, sem baixar arquivo.
   *
   * Separado de `obterConteudo` porque um processo com 200 documentos são
   * centenas de megabytes: listar precisa ser barato o bastante para abrir uma
   * tela, e baixar é uma decisão do usuário, peça a peça.
   */
  listarPecas(numeroProcesso: string, credencial: CredencialTribunal): Promise<Peca[]>;

  /**
   * As peças MAIS os movimentos que o tribunal entregou na mesma resposta.
   *
   * Opcional porque nem toda fonte de peças tem linha do tempo própria. Onde
   * existe, é o que permite entregar o documento na linha do evento em vez de
   * numa lista apartada no rodapé — a junção peça↔andamento só é afirmada
   * dentro de uma resposta do MNI, onde o `<documento>` aponta para o
   * `identificadorMovimento` do `<movimento>` que o juntou.
   *
   * NÃO é uma segunda consulta: `listarPecas` já paga o pedágio de pedir
   * `movimentos: true` (sem isso o tribunal não devolve documento nenhum) e
   * jogava os movimentos fora. Quem implementa os dois DEVE fazer
   * `listarPecas` delegar aqui, senão o tribunal é consultado duas vezes para
   * montar uma tela — e cada consulta custa dezenas de segundos.
   */
  listarAtos?(
    numeroProcesso: string,
    credencial: CredencialTribunal,
  ): Promise<AtosDoProcesso>;

  /** O arquivo de UMA peça. */
  obterConteudo(
    numeroProcesso: string,
    idPeca: string,
    credencial: CredencialTribunal,
  ): Promise<ConteudoPeca>;

  /**
   * Os arquivos de VÁRIAS peças numa consulta só.
   *
   * Existe porque cada consulta ao MNI paga um pedágio fixo — a linha do tempo
   * inteira, ≈ 180 KB, sem a qual o tribunal não manda documento nenhum — e
   * gasta uma ficha do limite do IP, que é um só para todos os assinantes.
   * Medido no TJGO (sonda de lote, 01/10/2026): 20 peças numa chamada, todas
   * idênticas às baixadas uma a uma, em 1,8 s. Pedir uma por vez seriam 278
   * chamadas para um processo; em lote, 14 a 28.
   *
   * NÃO lança por peça faltante: uma resposta com sucesso pode trazer só parte
   * do que foi pedido, e isso é informação (`ausentes`, `semTeor`), não erro.
   * Lança apenas o que vale para a consulta inteira — credencial recusada,
   * bloqueio, falta de habilitação, rede.
   *
   * Opcional porque nem toda fonte entrega mais de um arquivo por resposta;
   * quem precisa dele e não o encontra trata como operação não suportada.
   */
  obterConteudosEmLote?(
    numeroProcesso: string,
    idsPecas: readonly string[],
    credencial: CredencialTribunal,
  ): Promise<LoteDePecas>;

  /**
   * Até quando a fonte está em pausa por bloqueio do tribunal (disjuntor de
   * 403); `undefined` com o disjuntor fechado. Só informa — não consulta nada.
   * É o que deixa a tela dizer "pausado até HH:MM" sem bater na porta fechada.
   */
  pausadoAte?(): Date | undefined;

  /**
   * Assinatura barata do estado do processo, para detectar mudança sem baixar
   * nada. `undefined` quando a fonte não oferece esse atalho.
   *
   * O MNI oferece: `consultarAlteracao` devolve hashes de cabeçalho,
   * movimentações e documentos. É a diferença entre a vigilância perguntar
   * "mudou?" e a vigilância baixar o processo inteiro de hora em hora.
   */
  assinaturaDeMudanca?(
    numeroProcesso: string,
    credencial: CredencialTribunal,
  ): Promise<AssinaturaDeMudanca>;
}

/** O que uma resposta do tribunal traz sobre o processo, numa consulta só. */
export interface AtosDoProcesso {
  readonly pecas: readonly Peca[];
  /**
   * A linha do tempo COMO O TRIBUNAL A NUMERA — é dela que as peças penduram.
   * Vazia quando a fonte responde sem movimentos.
   */
  readonly movimentos: readonly Movimentacao[];
  /**
   * Nível de sigilo DO PROCESSO na origem (0 é público), quando a fonte informa.
   * É o que impede o leitor de guardar em disco um processo sob segredo de
   * justiça mesmo quando as fontes públicas não souberam dizer.
   */
  readonly nivelSigiloDoProcesso?: number;
  /**
   * As partes COMO O TRIBUNAL AS REGISTRA nos autos (cabeçalho da resposta), quando a fonte informa.
   * Só nome, polo, tipo de pessoa e advogados: o documento (CPF/CNPJ) e o endereço que o tribunal
   * entrega a quem tem procuração NÃO entram — a tela não precisa deles e o que não está aqui não
   * vaza. Ausente = a fonte não trouxe cabeçalho com partes (nunca "o processo não tem partes").
   */
  readonly partes?: readonly Parte[];
}

/** O que voltou de um pedido em lote, peça por peça. */
export interface LoteDePecas {
  readonly conteudos: readonly ConteudoPeca[];
  /** O documento veio na resposta, sem o arquivo. */
  readonly semTeor: readonly string[];
  /** O documento nem apareceu na resposta. */
  readonly ausentes: readonly string[];
  /** Peso da resposta inteira, em bytes — é o que adapta o lote seguinte. */
  readonly bytesResposta: number;
}

export interface AssinaturaDeMudanca {
  readonly cabecalho?: string;
  readonly movimentacoes?: string;
  readonly documentos?: string;
}
