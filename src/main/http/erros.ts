import { ZodError } from 'zod';
import type { MotivoDoGateway } from '../../domain/errors/index.js';
import {
  AcompanhamentoNaoEncontradoError,
  AssinaturaInativaError,
  AnaliseNaoEncontradaError,
  AtoDaProvidenciaInvalidoError,
  EntradaNaoAnalisavelError,
  AnaliseDePecaRecusadaError,
  ConfiguracaoDeIaRecusadaError,
  ModeloDeIaRecusadoError,
  InstrucaoDeIaRecusadaError,
  PrazoNaoCalculavelError,
  DriveRecusadoError,
  AssinaturaDeWebhookInvalidaError,
  GatewayDePagamentoIndisponivelError,
  GatewayDePagamentoRecusouError,
  PagamentoRecusadoError,
  ChaveApiNaoEncontradaError,
  PlanoJaExisteError,
  CredenciaisInvalidasError,
  CredencialTribunalAusenteError,
  CredencialTribunalInvalidaError,
  DomainError,
  EmailJaCadastradoError,
  EventoDeCalendarioNaoEncontradoError,
  ComprovanteInvalidoError,
  ComprovanteNaoEnviadoError,
  CustoInvalidoError,
  CustoNaoEncontradoError,
  LimiteDeCustosError,
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
  WorkspaceInvalidoError,
} from '../../domain/errors/index.js';

export interface RespostaDeErro {
  readonly status: number;
  readonly corpo: {
    readonly erro: string;
    readonly mensagem: string;
    readonly detalhes?: unknown;
  };
}

/** A frase de cada motivo da falha do gateway (v0.45.1). Nossa, nunca do gateway. */
const FRASE_DO_GATEWAY: Readonly<Record<MotivoDoGateway, string>> = {
  email_pagador: 'O Mercado Pago não aceitou o e-mail informado para o pagamento.',
  credencial:
    'O serviço de pagamento está com um problema de configuração do nosso lado.',
  parametro_invalido: 'O Mercado Pago não aceitou os dados do pedido de pagamento.',
  indisponivel:
    'O serviço de pagamento está indisponível no momento. Tente novamente em instantes.',
  desconhecido:
    'O Mercado Pago recusou o pedido por um motivo que não foi possível identificar.',
};

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

  if (
    erro instanceof NumeroCNJInvalidoError ||
    erro instanceof OabInvalidaError ||
    erro instanceof CustoInvalidoError
  ) {
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

  // Análise por IA (v0.38.0). Cada motivo tem a frase dele na tela; o corpo traz `motivo`.
  // Nenhum desses casos chamou o modelo.
  if (erro instanceof EntradaNaoAnalisavelError) {
    const status =
      erro.motivo === 'sem_plano' || erro.motivo === 'segredo_de_justica'
        ? 403
        : erro.motivo === 'limite_de_uso' || erro.motivo === 'limite_diario'
          ? 429
          : erro.motivo === 'ato_nao_encontrado'
            ? 409
            : erro.motivo === 'desligada'
              ? 503
              : 422;
    return {
      status,
      corpo: {
        erro: erro.codigo,
        mensagem: erro.message,
        detalhes: { motivo: erro.motivo },
      },
    };
  }

  // Análise de PEÇA por IA (v0.55.0). Cada motivo tem a frase dele na tela; o corpo traz `motivo` e
  // nenhum texto de peça. Nenhum desses casos chamou o modelo.
  if (erro instanceof AnaliseDePecaRecusadaError) {
    const status: Record<AnaliseDePecaRecusadaError['motivo'], number> = {
      indisponivel: 404,
      peca_nao_encontrada: 404,
      sem_plano: 403,
      peca_sigilosa: 403,
      processo_sigiloso: 403,
      peca_nao_baixada: 409,
      limite_de_uso: 429,
      limite_diario: 429,
      tribunal_nao_suportado: 422,
      sem_texto: 422,
      acima_de_40_paginas: 422,
      acima_de_80_mil_caracteres: 422,
      pdf_invalido: 422,
      pdf_protegido: 422,
      arquivo_grande: 422,
      desligada: 503,
    };
    return {
      status: status[erro.motivo],
      corpo: {
        erro: erro.codigo,
        mensagem: erro.message,
        detalhes: { motivo: erro.motivo },
      },
    };
  }

  // Painel de IA do /admin (v0.58.0): pedido do operador recusado, nada gravado.
  if (erro instanceof ConfiguracaoDeIaRecusadaError) {
    const status: Record<ConfiguracaoDeIaRecusadaError['motivo'], number> = {
      funcao_desconhecida: 400,
      valor_invalido: 400,
      confirmacao_necessaria: 409,
      ambiente_bloqueia: 409,
    };
    return {
      status: status[erro.motivo],
      corpo: {
        erro: erro.codigo,
        mensagem: erro.message,
        detalhes: { motivo: erro.motivo },
      },
    };
  }

  // Painel de IA do /admin, Fase B (v0.60.0): testar, publicar ou reverter modelo recusado; nada gravado.
  if (erro instanceof ModeloDeIaRecusadoError) {
    const status: Record<ModeloDeIaRecusadoError['motivo'], number> = {
      funcao_desconhecida: 400,
      modelo_fora_da_lista: 400,
      aprovacao_invalida: 400,
      teste_nao_encontrado: 404,
      estimativa_acima_do_teto: 422,
      teste_indisponivel: 503,
      modelo_igual_ao_atual: 409,
      teste_em_andamento: 409,
      confirmacao_necessaria: 409,
      teste_nao_concluido: 409,
      teste_de_outro_modelo: 409,
      teste_antigo: 409,
      modelo_atual_mudou: 409,
      veredito_bloqueado: 409,
      ressalva_exige_aprovacao: 409,
      sem_modelo_anterior: 409,
      modelo_anterior_indisponivel: 409,
    };
    return {
      status: status[erro.motivo],
      corpo: {
        erro: erro.codigo,
        mensagem: erro.message,
        detalhes: { motivo: erro.motivo },
      },
    };
  }

  // Painel de IA do /admin, Fase C (v0.61.0): instruções, experimento e conjunto de verificação recusados.
  if (erro instanceof InstrucaoDeIaRecusadaError) {
    const status: Record<InstrucaoDeIaRecusadaError['motivo'], number> = {
      funcao_desconhecida: 400,
      observacao_invalida: 400,
      versoes_invalidas: 400,
      caso_invalido: 400,
      versao_inexistente: 404,
      caso_nao_encontrado: 404,
      verificacao_nao_encontrada: 404,
      caso_sigiloso: 403,
      texto_vazio: 422,
      texto_grande: 422,
      caso_sem_texto: 422,
      estimativa_acima_do_teto: 422,
      limite_de_experimentos: 429,
      experimento_indisponivel: 503,
      verificacao_indisponivel: 503,
      confirmacao_necessaria: 409,
      rascunho_inexistente: 409,
      rascunho_mudou: 409,
      nada_para_reverter: 409,
      conta_do_dono_ausente: 409,
      experimento_em_andamento: 409,
      verificacao_em_andamento: 409,
    };
    return {
      status: status[erro.motivo],
      corpo: {
        erro: erro.codigo,
        mensagem: erro.message,
        detalhes: { motivo: erro.motivo },
      },
    };
  }

  // Google Drive (v0.42.0): o corpo traz `motivo` para a tela escolher a frase. A mensagem é do
  // sistema (nunca do Google). Nenhum desses casos, exceto os que nascem do retorno, chamou o Google.
  if (erro instanceof DriveRecusadoError) {
    const status: Record<DriveRecusadoError['motivo'], number> = {
      sem_plano: 403,
      nao_conectado: 409,
      precisa_reconectar: 409,
      estado_invalido: 400,
      conexao_recusada: 400,
      job_em_andamento: 409,
      limite_global: 429,
      job_nao_encontrado: 404,
      nada_para_enviar: 409,
    };
    return {
      status: status[erro.motivo],
      corpo: {
        erro: erro.codigo,
        mensagem: erro.message,
        detalhes: { motivo: erro.motivo },
      },
    };
  }

  // Cobrança recorrente (v0.44.0). O webhook inválido é 401 SEM dizer por quê (o motivo vai ao log);
  // o resto traz `motivo` para a tela escolher a frase. Nada daqui chamou o gateway, exceto os dois
  // últimos ramos, e nenhum repete texto do gateway.
  if (erro instanceof AssinaturaDeWebhookInvalidaError) {
    return { status: 401, corpo: { erro: erro.codigo, mensagem: erro.message } };
  }
  if (erro instanceof PagamentoRecusadoError) {
    const status: Record<PagamentoRecusadoError['motivo'], number> = {
      plano_sem_preco: 422,
      plano_nao_vendavel: 422,
      ciclo_nao_suportado: 422,
      conta_sem_email: 403,
      ja_assinante: 409,
      sem_recorrencia: 409,
      plano_desconhecido: 400,
      termos_nao_aceitos: 422,
      plano_ja_vigente: 409,
      email_do_pagador_invalido: 422,
    };
    return {
      status: status[erro.motivo],
      corpo: {
        erro: erro.codigo,
        mensagem: erro.message,
        detalhes: { motivo: erro.motivo },
      },
    };
  }
  // v0.45.1: sempre JSON e sempre com um motivo de lista fechada. 422 = o gateway RECUSOU o pedido;
  // 503 = o gateway está fora do ar. Nunca 502: o proxy do Easypanel troca 502/504 (e às vezes 503) por uma
  // página HTML e esconde o JSON — a tela, por isso, também sabe agir só com o status. A mensagem é nossa:
  // o texto do gateway pode ecoar o e-mail do pagador e nunca sai daqui.
  if (erro instanceof GatewayDePagamentoIndisponivelError) {
    return {
      status: 503,
      corpo: {
        erro: erro.codigo,
        mensagem: FRASE_DO_GATEWAY['indisponivel'],
        detalhes: { situacao: 'gateway_indisponivel', motivo: 'indisponivel' },
      },
    };
  }
  if (erro instanceof GatewayDePagamentoRecusouError) {
    return {
      status: 422,
      corpo: {
        erro: erro.codigo,
        mensagem: FRASE_DO_GATEWAY[erro.motivoDoGateway],
        detalhes: { situacao: 'gateway_recusou', motivo: erro.motivoDoGateway },
      },
    };
  }

  // Comprovantes de custo (v0.49.0): o corpo traz `motivo` para a tela escolher a frase. A mensagem é
  // do sistema (nunca do Google, nunca o nome do arquivo).
  if (erro instanceof ComprovanteInvalidoError) {
    const status = {
      arquivo_vazio: 400,
      arquivo_grande: 413,
      tipo_nao_aceito: 415,
    } as const;
    return {
      status: status[erro.motivo],
      corpo: {
        erro: erro.codigo,
        mensagem: erro.message,
        detalhes: { motivo: erro.motivo },
      },
    };
  }
  if (erro instanceof ComprovanteNaoEnviadoError) {
    const status = {
      drive_cheio: 422,
      limite_de_uso: 429,
      drive_indisponivel: 503,
      recusado: 422,
    } as const;
    return {
      status: status[erro.motivo],
      corpo: {
        erro: erro.codigo,
        mensagem: erro.message,
        detalhes: { motivo: erro.motivo },
      },
    };
  }

  // Centro de custos: o teto é do estado da conta (422 com o nome do limite), não do formato do pedido.
  if (erro instanceof LimiteDeCustosError) {
    return {
      status: 422,
      corpo: {
        erro: erro.codigo,
        mensagem: erro.message,
        detalhes: { limite: erro.limite },
      },
    };
  }

  // Aviso de prazo a partir da análise (v0.39.0): o corpo traz `motivo` para a tela escolher a frase.
  if (erro instanceof PrazoNaoCalculavelError) {
    return {
      status: erro.motivo === 'ato_nao_encontrado' ? 409 : 422,
      corpo: {
        erro: erro.codigo,
        mensagem: erro.message,
        detalhes: { motivo: erro.motivo },
      },
    };
  }

  if (
    erro instanceof AnaliseNaoEncontradaError ||
    erro instanceof ProcessoNaoEncontradoError ||
    erro instanceof AcompanhamentoNaoEncontradoError ||
    erro instanceof ChaveApiNaoEncontradaError ||
    erro instanceof JobDoLeitorNaoEncontradoError ||
    erro instanceof PecaDaPastaNaoEncontradaError ||
    erro instanceof EventoDeCalendarioNaoEncontradoError ||
    erro instanceof CustoNaoEncontradoError ||
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

  // Workspace informado à mão: inexistente é 404, malformado cai no 400 genérico abaixo.
  if (erro instanceof WorkspaceInvalidoError && erro.motivo === 'inexistente') {
    return { status: 404, corpo: { erro: erro.codigo, mensagem: erro.message } };
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
