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
export class ProviderIndisponivelError extends DomainError {
  // `string` e não o literal: `MniBloqueadoError` especializa este erro com
  // código próprio, e o literal impediria a subclasse de redefini-lo.
  readonly codigo: string = 'PROVIDER_INDISPONIVEL';

  constructor(
    readonly provider: string,
    motivo: string,
    options?: { cause?: unknown },
  ) {
    super(`Provider "${provider}" indisponível: ${motivo}`, options);
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
