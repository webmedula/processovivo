import { ZodError } from 'zod';
import {
  AcompanhamentoNaoEncontradoError,
  AssinaturaInativaError,
  AtoDaProvidenciaInvalidoError,
  ChaveApiNaoEncontradaError,
  PlanoJaExisteError,
  CredenciaisInvalidasError,
  CredencialTribunalAusenteError,
  CredencialTribunalInvalidaError,
  DomainError,
  EmailJaCadastradoError,
  EventoDeCalendarioNaoEncontradoError,
  FeedDoCalendarioAusenteError,
  FeedDoCalendarioNaoEncontradoError,
  TransicaoDeEventoInvalidaError,
  JobDoLeitorNaoEncontradoError,
  CalibracaoDeNumeracaoInvalidaError,
  ListagemDaPastaAusenteError,
  PecaDaPastaNaoEncontradaError,
  PecaSigilosaNaoGuardadaError,
  PastaSemPecasParaJuntarError,
  LeitorAindaNaoProntoError,
  PdfDoLeitorExpiradoError,
  PecasForaDoPdfError,
  LimiteDeArmazenamentoExcedidoError,
  MniBloqueadoError,
  SegredoDeJusticaNaoGuardadoError,
  NumeroCNJInvalidoError,
  OabInvalidaError,
  OperacaoNaoSuportadaError,
  ProcessoNaoEncontradoError,
  ProviderIndisponivelError,
  RecursoNaoIncluidoNoPlanoError,
  RespostaInvalidaError,
  SemHabilitacaoNosAutosError,
  SessaoInvalidaError,
  TeorNaoAutorizadoError,
  TodasAsFontesFalharamError,
  WorkspaceNaoResolvidoError,
} from '../../domain/errors/index.js';

export interface RespostaDeErro {
  readonly status: number;
  readonly corpo: {
    readonly erro: string;
    readonly mensagem: string;
    readonly detalhes?: unknown;
  };
}

/**
 * Tradução de erro de domínio para status HTTP.
 *
 * Fica em UM lugar de propósito. Espalhar `try/catch` com `reply.code(404)`
 * pelas rotas é como o mesmo erro acaba virando 404 numa rota e 500 na outra.
 *
 * A escolha dos códigos carrega significado operacional — é o que o painel do
 * Easypanel e qualquer monitoramento vão usar para decidir se há incidente:
 *
 *   400  culpa do cliente (número CNJ ou OAB malformados)
 *   404  consultamos e o processo não existe
 *   501  nenhuma fonte da cadeia sabe fazer essa busca
 *   502  as fontes externas falharam ou responderam lixo — problema RIO ACIMA
 *   503  fonte temporariamente indisponível; vale tentar de novo
 *   500  bug nosso — e só isso deve acordar alguém de madrugada
 *
 * Devolver 500 para tribunal fora do ar polui o alarme com ruído que não é
 * nosso e esconde o 500 que realmente importa.
 */
export function mapearErro(erro: unknown): RespostaDeErro {
  // Corpo de requisição fora do contrato é culpa do cliente, não falha nossa.
  // Sem este ramo, um campo faltando na requisição virava 500 — que acende
  // alarme de produção e esconde a informação de que basta corrigir o payload.
  // O detalhe do Zod vai junto: é o que diz QUAL campo está errado.
  if (erro instanceof ZodError) {
    return {
      status: 400,
      corpo: {
        erro: 'REQUISICAO_INVALIDA',
        mensagem: erro.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'corpo'}: ${i.message}`)
          .join('; '),
      },
    };
  }

  if (erro instanceof NumeroCNJInvalidoError || erro instanceof OabInvalidaError) {
    return { status: 400, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // 401 nos dois: é a autenticação DO PROCESSOVIVO que falhou, e a ação é a mesma —
  // entrar de novo. A mensagem de `CredenciaisInvalidasError` é propositalmente
  // a mesma para e-mail inexistente e senha errada; ver o erro de domínio.
  if (
    erro instanceof CredenciaisInvalidasError ||
    erro instanceof SessaoInvalidaError ||
    erro instanceof WorkspaceNaoResolvidoError
  ) {
    return { status: 401, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // 409: o pedido é válido, o estado do servidor é que conflita. 400 diria que
  // o e-mail está malformado, que é outra correção.
  if (erro instanceof EmailJaCadastradoError || erro instanceof PlanoJaExisteError) {
    return { status: 409, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // O feed público: um 404 só, com o mesmo corpo seco para token inválido,
  // revogado, assinatura bloqueada ou plano sem o recurso. Nada no corpo
  // distingue um caso do outro — nem o código.
  if (erro instanceof FeedDoCalendarioNaoEncontradoError) {
    return {
      status: 404,
      corpo: { erro: 'NAO_ENCONTRADO', mensagem: 'Não encontrado.' },
    };
  }

  // 409: descartado é final; o pedido é válido, o estado do evento é que não
  // admite a mudança.
  if (
    erro instanceof TransicaoDeEventoInvalidaError ||
    erro instanceof AtoDaProvidenciaInvalidoError
  ) {
    return { status: 409, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  if (
    erro instanceof ProcessoNaoEncontradoError ||
    erro instanceof AcompanhamentoNaoEncontradoError ||
    erro instanceof ChaveApiNaoEncontradaError ||
    erro instanceof JobDoLeitorNaoEncontradoError ||
    erro instanceof PecaDaPastaNaoEncontradaError ||
    erro instanceof EventoDeCalendarioNaoEncontradoError ||
    erro instanceof FeedDoCalendarioAusenteError
  ) {
    return { status: 404, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // 409: o pedido é válido e o PDF existirá — ainda não existe. A tela
  // consulta o progresso em vez de tratar como erro.
  if (
    erro instanceof LeitorAindaNaoProntoError ||
    erro instanceof ListagemDaPastaAusenteError ||
    erro instanceof PastaSemPecasParaJuntarError
  ) {
    return { status: 409, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // 410: existiu e não existe mais — "monte de novo", não "não encontrado".
  if (erro instanceof PdfDoLeitorExpiradoError) {
    return { status: 410, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  if (
    erro instanceof PecasForaDoPdfError ||
    erro instanceof CalibracaoDeNumeracaoInvalidaError
  ) {
    return { status: 400, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // 413: o conteúdo pedido não cabe na guarda temporária. É do cliente (dividir
  // a seleção, esperar o prazo), não 5xx — não é falha nossa nem rio acima.
  if (erro instanceof LimiteDeArmazenamentoExcedidoError) {
    return { status: 413, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // 403: não é que não possa ver — é que não guardamos. A mensagem diz o caminho.
  if (
    erro instanceof SegredoDeJusticaNaoGuardadoError ||
    erro instanceof PecaSigilosaNaoGuardadaError
  ) {
    return { status: 403, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  if (erro instanceof OperacaoNaoSuportadaError) {
    return { status: 501, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // 428 (Precondition Required) e não 401: quem chamou está autenticado no
  // Processo Vivo: o que falta é a credencial DELE no tribunal. Devolver 401 faria o
  // cliente HTTP e o navegador tratarem como sessão expirada e mandarem a pessoa
  // fazer login de novo — que não resolve nada e esconde o que falta fazer.
  if (erro instanceof CredencialTribunalAusenteError) {
    return { status: 428, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // 424 (Failed Dependency): a falha é numa credencial que o assinante nos deu
  // para usar em outro sistema. Não é 401 (nossa autenticação está boa) nem 502
  // (o tribunal respondeu certinho — recusou). E precisa ser distinguível dos
  // dois porque a ação é diferente: alguém precisa atualizar a senha.
  if (erro instanceof CredencialTribunalInvalidaError) {
    return { status: 424, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // 403 também, e pelo mesmo motivo: o tribunal respondeu e negou. A diferença
  // para `TeorNaoAutorizadoError` é o alcance — lá é UM documento, aqui é o
  // conteúdo inteiro do processo, e a ação de quem lê é diferente (conferir de
  // quem é a credencial cadastrada, não tentar outra peça).
  if (erro instanceof SemHabilitacaoNosAutosError) {
    return { status: 403, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // 403: o tribunal respondeu e negou o arquivo. É a resposta certa para quem
  // não tem procuração nos autos — e não 404, que diria que a peça não existe.
  if (erro instanceof TeorNaoAutorizadoError) {
    return { status: 403, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // 402 (Payment Required) e não 403: o assinante TEM direito ao recurso, o
  // que falta é o pagamento em dia. 403 diria "você não pode", que é a outra
  // conversa — e é a que o erro logo abaixo trata.
  if (erro instanceof AssinaturaInativaError) {
    return { status: 402, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // 403: está em dia e não tem direito a este recurso no plano que contratou.
  // Não é 402 (não há nada atrasado) nem 401 (a autenticação está boa).
  if (erro instanceof RecursoNaoIncluidoNoPlanoError) {
    return { status: 403, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  if (erro instanceof TodasAsFontesFalharamError) {
    return {
      status: 502,
      corpo: {
        erro: erro.codigo,
        mensagem: 'Nenhuma fonte de dados respondeu. Tente novamente em instantes.',
        detalhes: erro.tentativas,
      },
    };
  }

  // Antes do ramo genérico de indisponibilidade: o 403 do tribunal tem hora
  // para acabar, e dizer QUANDO é o que evita a pessoa insistir — cada
  // insistência durante o bloqueio é mais uma batida na mesma porta.
  if (erro instanceof MniBloqueadoError) {
    return {
      status: 503,
      corpo: {
        erro: erro.codigo,
        mensagem:
          'O tribunal bloqueou temporariamente as consultas deste servidor. ' +
          `Tente de novo depois de ${erro.retomarEm.toISOString()}.`,
        detalhes: { retomarEm: erro.retomarEm.toISOString() },
      },
    };
  }

  if (erro instanceof ProviderIndisponivelError) {
    return {
      status: 503,
      corpo: { erro: erro.codigo, mensagem: 'Fonte de dados indisponível no momento.' },
    };
  }

  if (erro instanceof RespostaInvalidaError) {
    return {
      status: 502,
      corpo: {
        erro: erro.codigo,
        mensagem: 'A fonte de dados respondeu em formato inesperado.',
      },
    };
  }

  if (erro instanceof DomainError) {
    return { status: 400, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }

  // Falha não prevista: a mensagem original NÃO vai para o cliente — ela pode
  // conter URL interna, trecho de payload ou a chave do DataJud. Vai para o log.
  return {
    status: 500,
    corpo: { erro: 'ERRO_INTERNO', mensagem: 'Erro interno do servidor.' },
  };
}
