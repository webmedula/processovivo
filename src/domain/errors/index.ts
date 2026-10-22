/**
 * Hierarquia de erros do domínio.
 *
 * Regra: a camada de domínio nunca lança `Error` cru nem erros de biblioteca.
 * Toda falha esperada tem um tipo, porque o orquestrador decide o que fazer
 * (tentar o próximo provider, desistir, propagar) a partir do TIPO do erro —
 * nunca a partir da mensagem.
 */
export abstract class DomainError extends Error {
  abstract readonly codigo: string;

  constructor(mensagem: string, options?: { cause?: unknown }) {
    super(mensagem, options as ErrorOptions);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** O número informado não é um número CNJ válido (formato ou dígito verificador). */
export class NumeroCNJInvalidoError extends DomainError {
  readonly codigo = 'NUMERO_CNJ_INVALIDO';

  constructor(
    readonly valorInformado: string,
    motivo: string,
  ) {
    super(`Número CNJ inválido "${valorInformado}": ${motivo}`);
  }
}

/** A OAB informada não é válida (formato ou UF). */
export class OabInvalidaError extends DomainError {
  readonly codigo = 'OAB_INVALIDA';

  constructor(valorInformado: string, motivo: string) {
    super(`OAB inválida "${valorInformado}": ${motivo}`);
  }
}

/**
 * A fonte respondeu com sucesso, mas não conhece esse processo.
 * NÃO é falha do provider — é uma resposta legítima.
 */
export class ProcessoNaoEncontradoError extends DomainError {
  readonly codigo = 'PROCESSO_NAO_ENCONTRADO';

  constructor(
    readonly criterio: string,
    readonly provider?: string,
  ) {
    super(
      provider
        ? `Nenhum processo encontrado para ${criterio} em "${provider}".`
        : `Nenhum processo encontrado para ${criterio}.`,
    );
  }
}

/**
 * O provider existe mas não implementa esta operação.
 * Ex.: o DataJud não expõe partes nem advogados, então não sabe buscar por OAB.
 * O orquestrador PULA o provider silenciosamente em vez de tratar como falha.
 */
export class OperacaoNaoSuportadaError extends DomainError {
  readonly codigo = 'OPERACAO_NAO_SUPORTADA';

  constructor(
    readonly provider: string,
    readonly operacao: string,
    motivo?: string,
  ) {
    super(
      `O provider "${provider}" não suporta a operação "${operacao}"` +
        (motivo ? `: ${motivo}` : '.'),
    );
  }
}

/**
 * O provider falhou: rede, timeout, 5xx, HTML inesperado, captcha, tribunal fora do ar.
 * É o erro que dispara o fallback para o próximo provider da cadeia.
 */
/**
 * O que a fonte disse sobre ONDE a chamada parou (v0.38.2), para o log dizer a causa de
 * uma indisponibilidade sem precisar adivinhar. Só dado já SANEADO pelo adapter que o
 * preenche: status HTTP, o passo do roteamento (um token curto) e o funil (contagens). Nunca
 * corpo cru, mensagem da fonte nem texto do pedido — a mensagem de um roteador pode ecoá-lo.
 */
export interface RoteamentoDaFalha {
  readonly status?: number;
  readonly passo?: string;
  readonly funil?: unknown;
}

/** Monta o roteamento sem campo `undefined` (`exactOptionalPropertyTypes`). */
export function roteamentoDaFalha(
  status?: number,
  passo?: string,
  funil?: unknown,
): RoteamentoDaFalha {
  return {
    ...(status !== undefined ? { status } : {}),
    ...(passo !== undefined ? { passo } : {}),
    ...(funil !== undefined ? { funil } : {}),
  };
}

export class ProviderIndisponivelError extends DomainError {
  // `string` e não o literal: `MniBloqueadoError` especializa este erro com
  // código próprio, e o literal impediria a subclasse de redefini-lo.
  readonly codigo: string = 'PROVIDER_INDISPONIVEL';
  /** Onde a chamada parou, quando a fonte informou (v0.38.2). Ver `RoteamentoDaFalha`. */
  readonly roteamento?: RoteamentoDaFalha;

  constructor(
    readonly provider: string,
    motivo: string,
    options?: { cause?: unknown; roteamento?: RoteamentoDaFalha },
  ) {
    super(
      `Provider "${provider}" indisponível: ${motivo}`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    if (options?.roteamento !== undefined) this.roteamento = options.roteamento;
  }
}

/** O provider respondeu, mas o payload não pôde ser mapeado para o domínio. */
export class RespostaInvalidaError extends DomainError {
  readonly codigo = 'RESPOSTA_INVALIDA';

  constructor(
    readonly provider: string,
    motivo: string,
    options?: { cause?: unknown },
  ) {
    super(`Resposta inválida de "${provider}": ${motivo}`, options);
  }
}

/**
 * Toda a cadeia de providers foi percorrida sem sucesso.
 * Carrega o histórico das tentativas para diagnóstico e observabilidade.
 */
export class TodasAsFontesFalharamError extends DomainError {
  readonly codigo = 'TODAS_AS_FONTES_FALHARAM';

  constructor(
    readonly criterio: string,
    readonly tentativas: ReadonlyArray<{ provider: string; erro: string }>,
  ) {
    const resumo = tentativas.map((t) => `${t.provider}: ${t.erro}`).join(' | ');
    super(`Nenhuma fonte respondeu para ${criterio}. Tentativas → ${resumo}`);
  }
}

/**
 * O tribunal recusou a credencial do advogado.
 *
 * Separado de `ProviderIndisponivelError` porque a reação certa é oposta:
 * indisponibilidade pede nova tentativa e fallback; credencial recusada pede
 * que uma PESSOA vá corrigir o cadastro. Retentar aqui não só não resolve como
 * empurra a conta do advogado para o bloqueio por tentativas — e aí o problema
 * deixa de ser nosso e passa a ser o acesso dele ao processo.
 */
export class CredencialTribunalInvalidaError extends DomainError {
  readonly codigo = 'CREDENCIAL_TRIBUNAL_INVALIDA';

  constructor(
    readonly provider: string,
    readonly mensagemDaFonte: string,
  ) {
    super(
      `O tribunal recusou a credencial cadastrada em "${provider}": ${mensagemDaFonte}. ` +
        'Atualize usuário e senha no cadastro de credenciais.',
    );
  }
}

/** Não há credencial cadastrada para este workspace no tribunal pedido. */
export class CredencialTribunalAusenteError extends DomainError {
  readonly codigo = 'CREDENCIAL_TRIBUNAL_AUSENTE';

  constructor(readonly tribunal: string) {
    super(
      `Nenhuma credencial cadastrada para o tribunal ${tribunal}. ` +
        'As peças do processo só são acessíveis a quem está habilitado nos autos, ' +
        'então é preciso cadastrar o acesso do advogado.',
    );
  }
}

/**
 * A fonte respondeu, conhece o documento, e devolveu o metadado SEM o conteúdo.
 *
 * É o caso mais comum de todos no MNI e não é falha nossa: sem procuração nos
 * autos, o serviço entrega a ficha do documento e omite o arquivo. Merece tipo
 * próprio para que a interface diga "você não está habilitado neste processo"
 * em vez de "erro ao baixar", que manda o advogado procurar defeito onde não há.
 */
export class TeorNaoAutorizadoError extends DomainError {
  readonly codigo = 'TEOR_NAO_AUTORIZADO';

  constructor(
    readonly numeroProcesso: string,
    readonly idPeca: string,
  ) {
    super(
      `O tribunal não liberou o teor da peça ${idPeca} do processo ${numeroProcesso}. ` +
        'Isso costuma significar que a credencial usada não está habilitada nos autos.',
    );
  }
}

/** O texto informado não tem forma de e-mail. */
export class EmailInvalidoError extends DomainError {
  readonly codigo = 'EMAIL_INVALIDO';

  constructor(readonly informado: string) {
    // O e-mail NÃO entra na mensagem: ela vai para log, e endereço de pessoa
    // em log é dado pessoal espalhado onde ninguém vai lembrar de apagar.
    super('O e-mail informado não é válido.');
  }
}

/** Já existe conta com este e-mail. */
export class EmailJaCadastradoError extends DomainError {
  readonly codigo = 'EMAIL_JA_CADASTRADO';

  constructor() {
    super(
      'Já existe uma conta com este e-mail. Entre com a sua senha, ' +
        'ou use outro endereço.',
    );
  }
}

/**
 * E-mail desconhecido OU senha errada — deliberadamente indistinguíveis.
 *
 * Um erro para cada caso transformaria a tela de login num verificador de
 * quem é cliente: bastaria testar endereços e ler a diferença das respostas
 * para levantar a lista de assinantes. Por isso existe UM erro só, com UMA
 * mensagem, e o serviço gasta o mesmo tempo nos dois caminhos.
 */
export class CredenciaisInvalidasError extends DomainError {
  readonly codigo = 'CREDENCIAIS_INVALIDAS';

  constructor() {
    super('E-mail ou senha incorretos.');
  }
}

/** A sessão não existe, expirou ou foi encerrada. */
export class SessaoInvalidaError extends DomainError {
  readonly codigo = 'SESSAO_INVALIDA';

  constructor() {
    super('Sua sessão expirou. Entre novamente.');
  }
}

/** A senha escolhida é curta demais para proteger a conta. */
export class SenhaFracaError extends DomainError {
  readonly codigo = 'SENHA_FRACA';

  constructor(readonly minimo: number) {
    super(`A senha precisa ter pelo menos ${minimo} caracteres.`);
  }
}

/**
 * A requisição passou pela autenticação sem resolver um ambiente.
 *
 * Só acontece com `PROCESSOVIVO_AUTH_DISABLED=true`, que é o modo de rede interna:
 * não há chave nem sessão, então não há de quem sejam os dados. Antes disso
 * virava `throw new Error` cru — 500, alarme de produção, e o modo documentado
 * simplesmente quebrado.
 */
export class WorkspaceNaoResolvidoError extends DomainError {
  readonly codigo = 'WORKSPACE_NAO_RESOLVIDO';

  constructor() {
    super(
      'Não foi possível identificar de quem são os dados nesta requisição. ' +
        'Entre com sua conta ou informe a chave de API.',
    );
  }
}

/**
 * O plano do assinante não inclui o recurso pedido.
 *
 * Distinto de "assinatura vencida" de propósito, porque as duas ações são
 * diferentes: aqui o assinante está em dia e precisa TROCAR de plano; lá ele
 * precisa pagar o que já contratou. Uma mensagem só para os dois casos manda
 * metade das pessoas fazer a coisa errada.
 *
 * A mensagem nomeia o plano que resolve. Erro que diz "não disponível" sem
 * dizer o que fazer é o mesmo que porta sem maçaneta.
 */
export class RecursoNaoIncluidoNoPlanoError extends DomainError {
  readonly codigo = 'RECURSO_NAO_INCLUIDO_NO_PLANO';

  constructor(
    readonly recurso: string,
    readonly planoAtual: string,
    /** Ausente quando nenhum plano cadastrado inclui o recurso. */
    readonly planoQueInclui?: string,
  ) {
    super(
      planoQueInclui
        ? `Seu plano (${planoAtual}) não inclui ${recurso}. ` +
            `O plano ${planoQueInclui} inclui — fale com a gente para trocar.`
        : `Seu plano (${planoAtual}) não inclui ${recurso}. Fale com a gente.`,
    );
  }
}

/**
 * A assinatura venceu, passou da carência ou foi cancelada.
 *
 * Só bloqueia o que CONSOME fonte externa e o que promete vigilância. Ler a
 * carteira já guardada continua liberado, e isso não é generosidade: trancar
 * alguém para fora dos próprios dados por atraso de pagamento é o tipo de
 * coisa que vira reclamação pública e estorno, e não acelera pagamento nenhum.
 */
export class AssinaturaInativaError extends DomainError {
  readonly codigo = 'ASSINATURA_INATIVA';

  constructor(readonly status: string) {
    super(
      status === 'cancelada'
        ? 'Esta assinatura foi cancelada. Seus dados continuam aqui — reative para voltar a consultar e a vigiar.'
        : 'Sua assinatura venceu e o prazo de carência terminou. A vigilância está parada. ' +
            'Seus dados continuam aqui — regularize para voltar a consultar e a vigiar.',
    );
  }
}

/**
 * O workspace informado à mão (CLI/admin) não serve para liberar assinatura: forma errada
 * (`malformado`) ou nenhuma conta, chave ativa ou chave do `.env` com esse id (`inexistente`).
 * Nada é gravado. A mensagem não repete o valor digitado.
 */
export class WorkspaceInvalidoError extends DomainError {
  readonly codigo = 'WORKSPACE_INVALIDO';

  constructor(readonly motivo: 'malformado' | 'inexistente') {
    super(
      motivo === 'malformado'
        ? 'Workspace malformado: use o identificador de 16 (chave) ou 32 (conta) caracteres hexadecimais.'
        : 'Nenhuma conta nem chave de API ativa tem esse workspace.',
    );
  }
}

/**
 * Código de plano que não existe.
 *
 * Só aparece por erro de digitação no comando de liberação ou por banco
 * editado à mão. Vale ser um erro nomeado mesmo assim: cair como 500 faria
 * parecer bug do sistema quando é letra trocada.
 */
export class PlanoDesconhecidoError extends DomainError {
  readonly codigo = 'PLANO_DESCONHECIDO';

  constructor(
    readonly informado: string,
    readonly conhecidos: readonly string[],
  ) {
    super(`Plano "${informado}" não existe. Planos: ${conhecidos.join(', ')}.`);
  }
}

/**
 * Plano com dado que não se sustenta: código fora do formato, preço
 * negativo, nenhum recurso — ou recurso que ainda não existe num plano posto
 * à venda. A mensagem é a razão, pronta para a tela do painel.
 */
export class PlanoInvalidoError extends DomainError {
  readonly codigo = 'PLANO_INVALIDO';

  constructor(motivo: string) {
    super(motivo);
  }
}

/** Criar um plano com um código que já está em uso. */
export class PlanoJaExisteError extends DomainError {
  readonly codigo = 'PLANO_JA_EXISTE';

  constructor(readonly codigoDoPlano: string) {
    super(
      `Já existe um plano com o código "${codigoDoPlano}". O código não muda depois de ` +
        'criado — edite o plano existente ou escolha outro código.',
    );
  }
}

/** Dias de teste, carência ou plano do teste fora do que faz sentido. */
export class RegrasDeAssinaturaInvalidasError extends DomainError {
  readonly codigo = 'REGRAS_DE_ASSINATURA_INVALIDAS';

  constructor(motivo: string) {
    super(motivo);
  }
}

/**
 * O tribunal respondeu, e não liberou o conteúdo do processo.
 *
 * **Distinto de "processo sem peças", e a diferença é a razão de esta classe
 * existir.** O MNI devolve `sucesso: true` com o cabeçalho completo — partes,
 * vara, valor da causa — e NENHUM movimento quando o consultante não está
 * habilitado nos autos. Sem aviso, sem código de erro, sem mensagem.
 *
 * Medido no TJGO em 09/2026: 3 KB, `nivelSigilo="0"`, zero `<movimento>`, zero
 * `<documento>`. O mesmo processo, para quem tem procuração, devolve 273 KB
 * com 278 documentos.
 *
 * Tratar isso como "nenhuma peça" diz ao advogado que o processo está vazio,
 * quando o que houve foi negativa de acesso. É a mesma confusão que o projeto
 * já proíbe entre "esse processo não existe" e "não consegui ver esse
 * processo" — aqui aplicada ao conteúdo em vez de ao processo.
 */
export class SemHabilitacaoNosAutosError extends DomainError {
  readonly codigo = 'SEM_HABILITACAO_NOS_AUTOS';

  constructor(readonly numeroProcesso: string) {
    super(
      'O tribunal devolveu apenas os dados públicos deste processo, sem a ' +
        'movimentação e sem os documentos. Isso acontece quando o acesso ' +
        'cadastrado não consta como representante nos autos. Confira se a ' +
        'credencial é do advogado que tem procuração neste processo.',
    );
  }
}

/**
 * O identificador de 8 hex informado para revogar não corresponde a nenhuma
 * chave de API emitida pela área administrativa.
 *
 * Não é ambíguo com "chave errada digitada": só o OPERADOR chega até aqui, e
 * ele nunca vê a chave inteira de novo — só o identificador que a listagem
 * mostra. Um identificador que não bate é erro de digitação ou chave já
 * revogada com outro identificador, nunca tentativa de adivinhar chave alheia.
 */
export class ChaveApiNaoEncontradaError extends DomainError {
  readonly codigo = 'CHAVE_API_NAO_ENCONTRADA';

  constructor(readonly identificador: string) {
    super(`Nenhuma chave de API com o identificador "${identificador}".`);
  }
}

/**
 * O OpenRouter não tem NENHUM provedor com retenção zero (ZDR) para o modelo pedido
 * (ou nenhum que cumpra também os demais requisitos do pedido). É indisponibilidade,
 * não defeito: quem chama NÃO repete, porque a única repetição possível seria sem ZDR,
 * e isso está proibido. Especializa `ProviderIndisponivelError` para quem já trata
 * indisponibilidade continuar tratando.
 */
export class ZdrIndisponivelError extends ProviderIndisponivelError {
  override readonly codigo: string = 'ZDR_INDISPONIVEL';

  /**
   * @param passo  o `failed_routing_step` que o OpenRouter informou — aqui, o filtro de política de dados
   * @param funil  o `routing_funnel` do erro (estrutura de contagens, sem texto)
   */
  constructor(
    provider: string,
    readonly modelo: string,
    readonly passo?: string,
    readonly funil?: unknown,
    status?: number,
  ) {
    super(
      provider,
      `o roteamento parou no filtro de política de dados (ZDR) para o modelo "${modelo}"` +
        (passo ? ` (passo: ${passo})` : '') +
        '; a chamada NÃO é repetida sem ZDR',
      { roteamento: roteamentoDaFalha(status, passo, funil) },
    );
  }
}

/**
 * Nenhum provedor atendeu, mas o passo do roteamento que falhou NÃO é o filtro de política de
 * dados (é, por exemplo, o de parâmetros suportados ou o de `provider.only`). Não é "sem ZDR":
 * chamar assim um 404 que veio de outro filtro esconderia a causa. Carrega o passo e o funil
 * exatamente como o OpenRouter os informou. Também NÃO se repete.
 */
export class SemProvedorQueAtendaError extends ProviderIndisponivelError {
  override readonly codigo: string = 'SEM_PROVEDOR_QUE_ATENDA';

  constructor(
    provider: string,
    readonly modelo: string,
    readonly passo?: string,
    readonly funil?: unknown,
    status?: number,
  ) {
    super(
      provider,
      `nenhum provedor atendeu "${modelo}": ` +
        (passo
          ? `o roteamento parou no passo "${passo}"`
          : 'o erro não informou o passo do roteamento'),
      { roteamento: roteamentoDaFalha(status, passo, funil) },
    );
  }
}

/**
 * O MNI está em pausa porque o tribunal devolveu HTTP 403.
 *
 * É um `ProviderIndisponivelError` — quem já tratava indisponibilidade continua
 * tratando, e a rota continua respondendo 503 — com uma informação a mais: QUANDO
 * vale a pena voltar. O 403 do MNI é bloqueio de IP do servidor, e o IP é um só
 * para todos os assinantes. Insistir durante a pausa não destrava nada e
 * prolonga o bloqueio de todo mundo; por isso o disjuntor fica no adapter, e o
 * erro sai sem nenhuma requisição enquanto ele estiver aberto.
 */
export class MniBloqueadoError extends ProviderIndisponivelError {
  override readonly codigo: string = 'MNI_BLOQUEADO';

  constructor(
    provider: string,
    readonly retomarEm: Date,
  ) {
    super(
      provider,
      'acesso bloqueado pelo tribunal (HTTP 403) — costuma ser bloqueio temporário ' +
        `do IP do servidor; as consultas ficam pausadas até ${retomarEm.toISOString()}`,
    );
  }
}

/**
 * A montagem do PDF combinado não produziu um arquivo em que se possa confiar.
 *
 * Em geral: a contagem de páginas do arquivo gerado não bate com a soma das
 * partes. O índice aponta páginas para o advogado (e, depois, para as citações
 * da análise); um índice desalinhado do arquivo manda a pessoa ler a peça
 * errada achando que leu a certa. Melhor não entregar.
 */
export class PdfInvalidoError extends DomainError {
  readonly codigo = 'PDF_INVALIDO';

  constructor(motivo: string, options?: { cause?: unknown }) {
    super(`Não foi possível montar o PDF combinado: ${motivo}`, options);
  }
}

/** A guarda temporária do leitor passou da cota — do PDF ou do workspace. */
export class LimiteDeArmazenamentoExcedidoError extends DomainError {
  readonly codigo = 'LIMITE_DE_ARMAZENAMENTO_EXCEDIDO';

  constructor(
    readonly alcance: 'pdf' | 'workspace',
    readonly limiteBytes: number,
  ) {
    super(
      alcance === 'pdf'
        ? `O PDF combinado passaria de ${mb(limiteBytes)} MB, o limite por arquivo. ` +
            'Selecione menos peças e combine em partes.'
        : `Os PDFs combinados guardados para você já ocupam o limite de ${mb(limiteBytes)} MB. ` +
            'Eles são apagados sozinhos depois de 24 horas; tente de novo mais tarde.',
    );
  }
}

/**
 * O pedido de combinação não existe PARA ESTE workspace.
 *
 * A mesma resposta para "não existe" e "existe e é de outro": diferenciar
 * as duas permitiria a quem tem um id alheio confirmar que ele é válido.
 */
export class JobDoLeitorNaoEncontradoError extends DomainError {
  readonly codigo = 'JOB_DO_LEITOR_NAO_ENCONTRADO';

  constructor(readonly jobId: string) {
    super('Combinação de peças não encontrada (ou já apagada pelo prazo de guarda).');
  }
}

/**
 * O PDF combinado existiu e saiu do disco (prazo de guarda, substituição ou
 * limpeza por cota). Recortar dele não é mais possível — e o sistema DIZ isso
 * em vez de baixar tudo de novo do tribunal sem ninguém pedir.
 */
export class PdfDoLeitorExpiradoError extends DomainError {
  readonly codigo = 'PDF_DO_LEITOR_EXPIRADO';

  constructor() {
    super(
      'O PDF combinado de onde as peças seriam recortadas já foi apagado ' +
        '(prazo de guarda ou espaço da conta). Monte um novo pelo leitor.',
    );
  }
}

/** Pediu um recorte com peças que não estão no PDF combinado. */
export class PecasForaDoPdfError extends DomainError {
  readonly codigo = 'PECAS_FORA_DO_PDF';

  constructor(readonly quantas: number) {
    super(
      quantas === 1
        ? 'Uma das peças pedidas não está neste PDF combinado.'
        : `${quantas} das peças pedidas não estão neste PDF combinado.`,
    );
  }
}

/** Pediu o PDF ou o índice de uma combinação que ainda não terminou. */
export class LeitorAindaNaoProntoError extends DomainError {
  readonly codigo = 'LEITOR_AINDA_NAO_PRONTO';

  constructor(readonly estado: string) {
    super(`O PDF combinado ainda não está pronto (situação: ${estado}).`);
  }
}

/**
 * Processo em segredo de justiça não tem o PDF combinado guardado.
 *
 * Decisão do dono até segunda ordem: o leitor guarda o arquivo em disco por
 * algumas horas, e processo sob sigilo é exatamente o conteúdo que não deve
 * ficar custodiado aqui nem por esse tempo. As peças avulsas continuam
 * disponíveis — elas vão do tribunal direto para a máquina do advogado.
 */
export class SegredoDeJusticaNaoGuardadoError extends DomainError {
  readonly codigo = 'SEGREDO_DE_JUSTICA_NAO_GUARDADO';

  constructor(readonly numeroProcesso: string) {
    super(
      'Este processo está em segredo de justiça, e o PDF combinado não é guardado ' +
        'para processos sob sigilo. Baixe as peças individualmente.',
    );
  }
}

/**
 * A Pasta digital não tem a listagem de peças deste processo.
 *
 * A listagem é o que diz quais peças existem, em que ordem e quais são
 * sigilosas — e quem a decide é o tribunal, não o navegador. Sem ela o pedido
 * de uma peça não tem como ser conferido (uma peça sigilosa seria guardada em
 * disco por um id que o cliente inventou). A tela resolve carregando as peças
 * do processo e pedindo de novo; por isso é 409, não erro.
 */
export class ListagemDaPastaAusenteError extends DomainError {
  readonly codigo = 'LISTAGEM_DA_PASTA_AUSENTE';

  constructor(readonly numeroProcesso: string) {
    super(
      'A lista de peças deste processo ainda não foi carregada do tribunal. ' +
        'Carregue as peças do processo e tente de novo.',
    );
  }
}

/**
 * A peça pedida não existe NESTE workspace e neste processo.
 *
 * Mesma resposta para "não existe" e "é de outro assinante": distinguir os dois
 * diria a um assinante que o id existe na pasta de outro.
 */
export class PecaDaPastaNaoEncontradaError extends DomainError {
  readonly codigo = 'PECA_DA_PASTA_NAO_ENCONTRADA';

  constructor(readonly pecaId: string) {
    super(
      'Peça não encontrada na pasta deste processo (ou já apagada pelo prazo de guarda).',
    );
  }
}

/**
 * Peça sob sigilo não é guardada na Pasta digital.
 *
 * Mesma decisão do PDF combinado: o que fica em disco, ainda que por horas, não
 * pode ser conteúdo sigiloso. O download avulso pela linha do tempo continua —
 * ele vai do tribunal direto para a máquina de quem tem acesso.
 */
export class PecaSigilosaNaoGuardadaError extends DomainError {
  readonly codigo = 'PECA_SIGILOSA_NAO_GUARDADA';

  constructor(readonly pecaId: string) {
    super(
      'Esta peça está sob sigilo e não é guardada na Pasta digital. ' +
        'Baixe-a individualmente pela linha do tempo.',
    );
  }
}

/**
 * Montar ou baixar a Pasta sem nenhuma peça que se possa guardar.
 *
 * Todas sob sigilo, ou a lista vazia. É 409 e não "erro": o pedido é válido, o
 * estado do processo é que não tem o que juntar — e a mensagem diz isso, em vez
 * de entregar um PDF de zero páginas.
 */
export class PastaSemPecasParaJuntarError extends DomainError {
  readonly codigo = 'PASTA_SEM_PECAS_PARA_JUNTAR';

  constructor(readonly numeroProcesso: string) {
    super(
      'Não há peça que possa ser juntada: a seleção está vazia ou só tem peças sob sigilo, ' +
        'que não são guardadas. Baixe-as individualmente pela linha do tempo.',
    );
  }
}

function mb(bytes: number): number {
  return Math.round(bytes / 1_048_576);
}

/**
 * Evento do calendário fora do contrato: data que não existe no calendário,
 * hora fora do relógio, título vazio, intervalo de consulta grande demais.
 *
 * 400: é o pedido que está errado, e a mensagem diz qual campo.
 */
export class EventoDeCalendarioInvalidoError extends DomainError {
  readonly codigo = 'EVENTO_DE_CALENDARIO_INVALIDO';

  constructor(motivo: string) {
    super(motivo);
  }
}

/**
 * O evento não existe PARA ESTE workspace.
 *
 * Mesma resposta para "não existe" e "é de outro": diferenciar permitiria a
 * quem tem um id alheio confirmar que ele é válido.
 */
export class EventoDeCalendarioNaoEncontradoError extends DomainError {
  readonly codigo = 'EVENTO_DE_CALENDARIO_NAO_ENCONTRADO';

  constructor(readonly eventoId: string) {
    super('Evento não encontrado no seu calendário.');
  }
}

/**
 * Mudança de estado que o evento não admite — em geral, mexer num evento
 * descartado. Descartado é final de propósito: é o que garante que uma
 * sugestão recusada pelo advogado nunca volte a aparecer.
 */
export class TransicaoDeEventoInvalidaError extends DomainError {
  readonly codigo = 'TRANSICAO_DE_EVENTO_INVALIDA';

  constructor(
    readonly de: string,
    readonly acao: string,
  ) {
    super(`Um evento ${de} não pode ser ${acao}.`);
  }
}

/**
 * O feed ICS pedido não existe — ou existe e não pode ser servido.
 *
 * Um erro só para token inválido, token revogado, assinatura bloqueada e
 * plano sem o recurso, e a tradução HTTP é um 404 sem corpo informativo. A URL
 * do feed vive anos dentro do Google Agenda de alguém: qualquer diferença entre
 * as respostas ensinaria a quem a encontrou que o token já valeu, ou de quem
 * é a assinatura.
 */
export class FeedDoCalendarioNaoEncontradoError extends DomainError {
  readonly codigo = 'NAO_ENCONTRADO';

  constructor() {
    super('Não encontrado.');
  }
}

/**
 * Pediu para alterar o feed, e o workspace não tem feed vigente. É da rota
 * AUTENTICADA (`PATCH /v1/calendario/feed`): diz com clareza o que falta,
 * porque quem pergunta é o dono da agenda — diferente do feed público.
 */
export class FeedDoCalendarioAusenteError extends DomainError {
  readonly codigo = 'FEED_DO_CALENDARIO_AUSENTE';

  constructor() {
    super('Você ainda não tem um feed do calendário. Crie um antes de alterá-lo.');
  }
}

/**
 * O número informado do Projudi não serve como âncora de calibração: fora dos
 * atos recebidos, abaixo da posição, incompatível com os outros já informados
 * (o deslocamento nunca diminui) ou além do limite por processo. A mensagem diz
 * qual — é o que a pessoa precisa para conferir o que digitou. 400: a correção
 * está no que ela mandou.
 */
export class CalibracaoDeNumeracaoInvalidaError extends DomainError {
  readonly codigo = 'CALIBRACAO_DE_NUMERACAO_INVALIDA';

  constructor(motivo: string) {
    super(motivo);
  }
}

/**
 * Pediu algo sobre um processo que este workspace não acompanha (ou que nunca
 * foi lido). 404 com a mesma resposta para "não existe" e "é de outra conta".
 */
export class AcompanhamentoNaoEncontradoError extends DomainError {
  readonly codigo = 'ACOMPANHAMENTO_NAO_ENCONTRADO';

  constructor() {
    super('Este processo não está sendo acompanhado.');
  }
}

/**
 * A marca de "cumprido" apontou para um ato que não serve: não está mais no
 * retrato do processo (a tela estava desatualizada) ou não pede providência.
 * 409 — o pedido é válido, o estado do processo é que não o admite; a tela
 * recarrega e a pessoa decide de novo.
 */
export class AtoDaProvidenciaInvalidoError extends DomainError {
  readonly codigo = 'ATO_DA_PROVIDENCIA_INVALIDO';

  constructor(motivo: string) {
    super(motivo);
  }
}

/**
 * O ato NÃO pode ser analisado por IA, e a razão é do ato ou da conta, não de
 * falha: a tela mostra a frase própria de cada `motivo`. Nenhum desses casos
 * chama o modelo — a checagem acontece antes de qualquer saída de dados.
 *
 * - `sem_plano`: a conta não tem o plano IA (sem exceção, nem para quem não tem
 *   assinatura: chave de API e conta sem assinatura também não passam);
 * - `segredo_de_justica`: o texto de processo sigiloso nunca sai do sistema;
 * - `texto_insuficiente`: o ato só tem rótulo (ou quase), não há o que ler;
 * - `texto_indisponivel`: o tribunal avisou que o teor não é público — outro
 *   problema, outra frase: o advogado precisa abrir o processo no tribunal;
 * - `limite_de_uso`: limite por hora da conta, ou análises demais em curso;
 * - `limite_diario`: o teto técnico de segurança do dia (v0.50.0) — não é limite do plano;
 * - `ato_nao_encontrado`: o ato saiu do retrato (a tela estava desatualizada).
 */
export type MotivoDeEntradaNaoAnalisavel =
  | 'sem_plano'
  | 'segredo_de_justica'
  | 'texto_insuficiente'
  | 'texto_indisponivel'
  | 'limite_de_uso'
  | 'limite_diario'
  | 'ato_nao_encontrado';

export class EntradaNaoAnalisavelError extends DomainError {
  readonly codigo = 'ENTRADA_NAO_ANALISAVEL';

  constructor(
    readonly motivo: MotivoDeEntradaNaoAnalisavel,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

/** Por que o aviso de prazo não pôde ser montado (v0.39.0). */
export type MotivoDePrazoNaoCalculavel =
  | 'sem_prazo_na_analise'
  | 'ato_fora_do_diario'
  | 'ato_nao_encontrado'
  | 'tipo_necessario';

/**
 * Prazo calculado a partir de uma análise: a análise não tem prazo, o ato não é do Diário
 * (sem data de disponibilização não há termo inicial), o ato saiu do retrato, ou o ato não diz
 * se os dias são úteis ou corridos e o advogado ainda não escolheu. NENHUM chamou o modelo.
 */
export class PrazoNaoCalculavelError extends DomainError {
  readonly codigo = 'PRAZO_NAO_CALCULAVEL';

  constructor(
    readonly motivo: MotivoDePrazoNaoCalculavel,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

/** A análise pedida não existe PARA ESTE workspace (ou é de outro): 404, mesma resposta. */
export class AnaliseNaoEncontradaError extends DomainError {
  readonly codigo = 'ANALISE_NAO_ENCONTRADA';

  constructor() {
    super('Essa análise não foi encontrada.');
  }
}

// ---------------------------------------------------------------------------
// Google Drive (v0.42.0). O resto do sistema fala de "destino externo de peças";
// só o adapter sabe que é o Google.

/** Por que uma ação do Drive foi recusada ANTES de qualquer chamada ao Google. */
export type MotivoDeDriveRecusado =
  | 'sem_plano'
  | 'nao_conectado'
  | 'precisa_reconectar'
  | 'estado_invalido'
  | 'conexao_recusada'
  | 'job_em_andamento'
  | 'limite_global'
  | 'job_nao_encontrado'
  | 'nada_para_enviar';

/**
 * O Drive não pode ser usado agora, e a razão é da conta ou do pedido, não de falha:
 * a tela mostra a frase própria de cada `motivo`. Nenhum desses casos chamou o Google
 * (exceto `conexao_recusada` e `estado_invalido`, que nascem DEPOIS do retorno dele).
 */
export class DriveRecusadoError extends DomainError {
  readonly codigo = 'DRIVE_RECUSADO';

  constructor(
    readonly motivo: MotivoDeDriveRecusado,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

/**
 * A autorização do advogado não vale mais: ele a revogou no Google, ela expirou
 * (`invalid_grant`) ou ele não marcou a permissão da pasta na tela de consentimento.
 * A saída é reconectar — nunca insistir.
 */
export class AutorizacaoDoDestinoRevogadaError extends DomainError {
  readonly codigo = 'AUTORIZACAO_DO_DESTINO_REVOGADA';

  constructor(
    readonly motivo: 'revogada' | 'escopo_negado',
    mensagem: string,
  ) {
    super(mensagem);
  }
}

/** O Drive do advogado está cheio (`storageQuotaExceeded`): o lote para e ele é orientado. */
export class DestinoSemEspacoError extends DomainError {
  readonly codigo = 'DESTINO_SEM_ESPACO';

  constructor() {
    super('O Google Drive está sem espaço livre.');
  }
}

/** O Google pediu para esperar (429, `userRateLimitExceeded`). `esperarMs` vem de `Retry-After`. */
export class DestinoLimitouError extends DomainError {
  readonly codigo = 'DESTINO_LIMITOU';

  constructor(readonly esperarMs: number | undefined) {
    super('O Google Drive limitou o uso por agora.');
  }
}

/** Rede, timeout ou 5xx do Google. É transitório; o serviço repete um número limitado de vezes. */
export class DestinoIndisponivelError extends DomainError {
  readonly codigo = 'DESTINO_INDISPONIVEL';

  constructor(readonly status: number | undefined) {
    super('O Google Drive não respondeu.');
  }
}

/** O Google respondeu e recusou o pedido (4xx que não é nenhum dos acima). Sem texto do Google. */
export class DestinoRecusouError extends DomainError {
  readonly codigo = 'DESTINO_RECUSOU';

  constructor(readonly status: number) {
    super(`O Google Drive recusou o pedido (HTTP ${status}).`);
  }
}

/** O arquivo que o sistema criou foi apagado ou está na lixeira. Reenviar só por clique. */
export class ArquivoRemovidoNoDestinoError extends DomainError {
  readonly codigo = 'ARQUIVO_REMOVIDO_NO_DESTINO';

  constructor() {
    super('O arquivo foi removido do Google Drive.');
  }
}

/** A pasta (raiz ou do processo) foi apagada ou está na lixeira. */
export class PastaRemovidaNoDestinoError extends DomainError {
  readonly codigo = 'PASTA_REMOVIDA_NO_DESTINO';

  constructor() {
    super('A pasta foi removida do Google Drive.');
  }
}

/**
 * O destino respondeu 401: o token de acesso venceu (relógio, renovação perdida). Não é
 * revogação — quem chama renova UMA vez e repete; só se a renovação der `invalid_grant`
 * é que a conexão vira "precisa reconectar".
 */
export class AutorizacaoDoDestinoVencidaError extends DomainError {
  readonly codigo = 'AUTORIZACAO_DO_DESTINO_VENCIDA';

  constructor() {
    super('A autorização do Google Drive venceu.');
  }
}

// ---------------------------------------------------------------------------
// Cobrança recorrente pelo gateway de pagamento (v0.44.0). Nenhum desses erros carrega dado de
// cartão, token, segredo nem texto cru do gateway.

/**
 * Por que o gateway falhou, numa lista FECHADA (v0.45.1). É o que a tela e a API usam para escolher a
 * frase — nunca o texto do gateway, que pode ecoar o e-mail do pagador:
 * - `email_pagador`: o gateway não aceitou o e-mail do pagador;
 * - `credencial`: o token foi recusado (problema nosso, de configuração);
 * - `parametro_invalido`: outro campo do pedido foi recusado (URL de retorno, valor, ciclo…);
 * - `indisponivel`: o gateway está fora do ar, lento ou limitando;
 * - `desconhecido`: respondeu 4xx e nada do que veio permite dizer por quê.
 */
export type MotivoDoGateway =
  'email_pagador' | 'credencial' | 'parametro_invalido' | 'indisponivel' | 'desconhecido';

/**
 * O que a recusa do gateway diz, JÁ SANEADO (e-mail mascarado, sem token, sem corpo bruto): é o que vai
 * ao log e à trilha de auditoria. Nunca sai pela API.
 */
export interface DiagnosticoDoGateway {
  readonly operacao: string;
  readonly status: number;
  readonly erro?: string;
  readonly mensagem?: string;
  readonly causas: ReadonlyArray<{
    readonly codigo?: string;
    readonly descricao?: string;
  }>;
  /** Só os NOMES dos campos enviados no pedido (`auto_recurring.frequency`…), nunca os valores. */
  readonly camposEnviados: readonly string[];
}

/** O gateway não respondeu: rede, timeout, 5xx, limite. Nada foi cobrado de forma confirmada. */
export class GatewayDePagamentoIndisponivelError extends ProviderIndisponivelError {
  override readonly codigo: string = 'GATEWAY_DE_PAGAMENTO_INDISPONIVEL';
  readonly motivoDoGateway: MotivoDoGateway = 'indisponivel';

  constructor(gateway: string, motivo: string, options?: { cause?: unknown }) {
    super(gateway, motivo, options);
  }
}

/** O gateway respondeu e recusou o pedido (4xx definitivo) ou devolveu algo fora do contrato. */
export class GatewayDePagamentoRecusouError extends DomainError {
  readonly codigo = 'GATEWAY_DE_PAGAMENTO_RECUSOU';
  readonly motivoDoGateway: MotivoDoGateway;
  readonly diagnostico: DiagnosticoDoGateway | undefined;

  constructor(
    readonly gateway: string,
    readonly status: number | undefined,
    motivo: string,
    extra: {
      readonly motivoDoGateway?: MotivoDoGateway;
      readonly diagnostico?: DiagnosticoDoGateway;
    } = {},
  ) {
    super(`Gateway de pagamento "${gateway}" recusou o pedido: ${motivo}`);
    this.motivoDoGateway = extra.motivoDoGateway ?? 'desconhecido';
    this.diagnostico = extra.diagnostico;
  }
}

/**
 * O aviso (webhook) não prova que veio do gateway: assinatura ausente, malformada, adulterada,
 * de outro recurso ou velha demais. 401, e NADA é gravado. A mensagem nunca diz qual foi o motivo
 * exato a quem chama (isso ajudaria a forjar); o motivo vai só para o log.
 */
export class AssinaturaDeWebhookInvalidaError extends DomainError {
  readonly codigo = 'ASSINATURA_DE_WEBHOOK_INVALIDA';

  constructor(
    readonly motivo:
      | 'ausente'
      | 'malformada'
      | 'sem_timestamp'
      | 'sem_hash'
      | 'sem_segredo'
      | 'diferente'
      | 'fora_do_prazo',
  ) {
    super('Assinatura do webhook inválida.');
  }
}

export type MotivoDePagamentoRecusado =
  | 'plano_sem_preco'
  | 'plano_nao_vendavel'
  | 'ciclo_nao_suportado'
  | 'conta_sem_email'
  | 'ja_assinante'
  | 'sem_recorrencia'
  | 'plano_desconhecido'
  | 'termos_nao_aceitos'
  | 'plano_ja_vigente'
  | 'email_do_pagador_invalido';

/**
 * O pedido de cobrança não se aplica, e a razão é da conta ou do plano — nenhum desses casos chamou o
 * gateway. O corpo da resposta traz `detalhes.motivo` para a tela escolher a frase.
 */
export class PagamentoRecusadoError extends DomainError {
  readonly codigo = 'PAGAMENTO_RECUSADO';

  constructor(
    readonly motivo: MotivoDePagamentoRecusado,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

/**
 * Centro de custos (v0.47.0): o lançamento ou a categoria não passa nas regras — valor fora da
 * faixa, descrição vazia, data que não existe, nome repetido. 400: o pedido é que está errado, e
 * a mensagem (em português, curta) diz qual campo. NUNCA carrega o valor, a descrição ou o nome
 * recebidos: o dado de custo é do cliente do advogado e não vai a log nem a erro.
 */
export class CustoInvalidoError extends DomainError {
  readonly codigo = 'CUSTO_INVALIDO';

  constructor(motivo: string) {
    super(motivo);
  }
}

/**
 * O lançamento ou a categoria de custo não existe PARA ESTE workspace. Mesma resposta para
 * "não existe" e "é de outra conta": diferenciar deixaria quem tem um id alheio confirmá-lo.
 */
export class CustoNaoEncontradoError extends DomainError {
  readonly codigo = 'CUSTO_NAO_ENCONTRADO';

  constructor() {
    super('Lançamento ou categoria não encontrado na sua conta.');
  }
}

/** Teto de lançamentos por processo ou de categorias próprias por conta. 422 com `detalhes.limite`. */
export class LimiteDeCustosError extends DomainError {
  readonly codigo = 'LIMITE_DE_CUSTOS';

  constructor(
    readonly limite: 'lancamentos' | 'categorias' | 'recebimentos' | 'comprovantes',
    readonly maximo: number,
  ) {
    super(
      limite === 'lancamentos'
        ? `Este processo já tem ${maximo} lançamentos, o máximo permitido.`
        : limite === 'recebimentos'
          ? `Este processo já tem ${maximo} recebimentos, o máximo permitido.`
          : limite === 'comprovantes'
            ? `Este lançamento já tem ${maximo} comprovantes, o máximo permitido. Remova algum para anexar outro.`
            : `Você já tem ${maximo} subcategorias próprias, o máximo permitido. Arquive alguma para criar outra.`,
    );
  }
}

/**
 * O arquivo do comprovante não passa nas regras (v0.49.0): vazio, maior que 5 MB, ou que não é PDF,
 * JPEG nem PNG DE VERDADE (conferido pelos primeiros bytes, não pela extensão). A mensagem é do
 * sistema e nunca repete o nome nem o conteúdo recebidos. NENHUM chamou o Google.
 */
export type MotivoDeComprovanteInvalido =
  'arquivo_vazio' | 'arquivo_grande' | 'tipo_nao_aceito';
export class ComprovanteInvalidoError extends DomainError {
  readonly codigo = 'COMPROVANTE_INVALIDO';

  constructor(
    readonly motivo: MotivoDeComprovanteInvalido,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

/**
 * O Google Drive recusou ou não conseguiu guardar o comprovante (v0.49.0). A frase é NOSSA — o
 * texto do Google nunca sai — e o `motivo` deixa a tela escolher a explicação.
 */
export type MotivoDeComprovanteNaoEnviado =
  'drive_cheio' | 'limite_de_uso' | 'drive_indisponivel' | 'recusado';
export class ComprovanteNaoEnviadoError extends DomainError {
  readonly codigo = 'COMPROVANTE_NAO_ENVIADO';

  constructor(
    readonly motivo: MotivoDeComprovanteNaoEnviado,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

/**
 * Por que o texto de um PDF não pôde ser extraído (v0.53.0, Fase 0 da análise de peças).
 * O módulo de extração é interno e a mensagem é SEMPRE uma frase nossa: nunca texto da peça,
 * nome de arquivo nem a saída do `pdftotext`.
 */
export type MotivoDeExtracaoRecusada =
  | 'arquivo_vazio'
  | 'arquivo_grande'
  | 'pdf_invalido'
  | 'pdf_protegido'
  | 'tempo_esgotado'
  | 'saida_grande_demais'
  | 'ferramenta_ausente';
export class ExtracaoDeTextoError extends DomainError {
  readonly codigo = 'EXTRACAO_DE_TEXTO';

  constructor(
    readonly motivo: MotivoDeExtracaoRecusada,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

/**
 * A PEÇA não pode ser analisada por IA (v0.55.0, Fase 1). Cada `motivo` tem a frase própria na
 * tela; o corpo da resposta traz só o motivo. NENHUM desses casos chamou o modelo — e nenhum
 * carrega texto de peça, nome de arquivo ou número de processo na mensagem.
 *
 * - `indisponivel`: nenhuma das chaves libera esta conta (a rota "não existe" para ela);
 * - `sem_plano`: falta o recurso `analiseIa` (sem exceção, como no ato e no resumo);
 * - `peca_sigilosa` / `processo_sigiloso`: sigilo nunca sai do sistema;
 * - `tribunal_nao_suportado`: só o TJGO tem peças hoje;
 * - `peca_nao_encontrada` / `peca_nao_baixada`: não está na listagem DESTA conta / não está na guarda
 *   de 24 h (a tela baixa e pede de novo);
 * - `sem_texto`: PDF sem camada de texto (escaneado) — sem OCR; `acima_de_40_paginas` e
 *   `acima_de_80_mil_caracteres`: limites por peça; `pdf_invalido` / `pdf_protegido` / `arquivo_grande`:
 *   o PDF não pôde ser lido;
 * - `limite_de_uso` / `limite_diario`: freio por hora e teto técnico do dia (não é limite do plano).
 */
export type MotivoDeAnaliseDePecaRecusada =
  | 'indisponivel'
  | 'sem_plano'
  | 'peca_sigilosa'
  | 'processo_sigiloso'
  | 'tribunal_nao_suportado'
  | 'peca_nao_encontrada'
  | 'peca_nao_baixada'
  | 'sem_texto'
  | 'acima_de_40_paginas'
  | 'acima_de_80_mil_caracteres'
  | 'pdf_invalido'
  | 'pdf_protegido'
  | 'arquivo_grande'
  | 'limite_de_uso'
  | 'limite_diario';

export class AnaliseDePecaRecusadaError extends DomainError {
  readonly codigo = 'ANALISE_DE_PECA_RECUSADA';

  constructor(
    readonly motivo: MotivoDeAnaliseDePecaRecusada,
    mensagem: string,
  ) {
    super(mensagem);
  }
}
