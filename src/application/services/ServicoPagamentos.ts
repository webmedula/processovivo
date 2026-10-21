import { randomBytes } from 'node:crypto';
import type {
  AmbienteDoGateway,
  EstadoDaRecorrencia,
  EventoDeWebhook,
  MeioDeCobranca,
  PagamentoNoGateway,
  ResultadoDoPagamento,
} from '../../domain/entities/Pagamento.js';
import {
  CICLOS_VENDAVEIS,
  MESES_POR_CICLO,
  cicloDoPlano,
  valorDoCicloEmCentavos,
} from '../../domain/entities/Plano.js';
import type { CicloDoPlano, Plano } from '../../domain/entities/Plano.js';
import { normalizarEmail } from '../../domain/entities/Usuario.js';
import {
  EmailInvalidoError,
  GatewayDePagamentoIndisponivelError,
  GatewayDePagamentoRecusouError,
  PagamentoRecusadoError,
} from '../../domain/errors/index.js';
import type { MotivoDoGateway } from '../../domain/errors/index.js';
import type { MotivoDePagamentoRecusado } from '../../domain/errors/index.js';
import type { GatewayDePagamento } from '../../domain/ports/GatewayDePagamento.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { Notificador } from '../../domain/ports/Notificador.js';
import type { RepositorioPagamentos } from '../../domain/ports/RepositorioPagamentos.js';
import type {
  AceiteDeTermos,
  CobrancaRecorrente,
  EventoDePagamento,
} from '../../domain/ports/RepositorioPagamentos.js';
import type { RepositorioPlanos } from '../../domain/ports/RepositorioPlanos.js';
import type { RepositorioUsuarios } from '../../domain/ports/RepositorioUsuarios.js';
import type { ServicoAssinaturas } from './ServicoAssinaturas.js';

/** O caminho que o gateway chama. Pública no servidor: quem autentica é a assinatura do aviso. */
export const ROTA_DO_WEBHOOK_MERCADO_PAGO = '/v1/pagamentos/webhook/mercadopago';
/** Para onde o comprador volta depois do checkout. A tela lê `?assinatura=retorno`; o estado vem do servidor. */
export const QUERY_DE_RETORNO = '?assinatura=retorno';

/** Depois disto, um checkout que ninguém concluiu deixa de aparecer como "processando". */
const JANELA_DO_CHECKOUT_EM_ABERTO_MS = 2 * 60 * 60 * 1000;

export interface OpcoesServicoPagamentos {
  readonly gateway: GatewayDePagamento;
  readonly repositorio: RepositorioPagamentos;
  readonly planos: RepositorioPlanos;
  readonly assinaturas: ServicoAssinaturas;
  readonly usuarios: RepositorioUsuarios;
  readonly logger: Logger;
  readonly notificador?: Notificador;
  /** `PROCESSOVIVO_TERMOS_VERSAO`: a versão dos Termos que o aceite do checkout registra. */
  readonly versaoDosTermos: string;
  /** `PROCESSOVIVO_URL_BASE`: de onde saem a URL de retorno e a de notificação. */
  readonly urlBase: string;
  /** Quem recebe o aviso de estorno e contestação. Sem ele, o aviso só vai para o log. */
  readonly emailDoOperador?: string;
  readonly agora?: () => Date;
  /** Só para teste. */
  readonly gerarReferencia?: () => string;
}

export interface RecorrenciaVisivel {
  readonly estado: EstadoDaRecorrencia;
  readonly plano: string;
  readonly ciclo: CicloDoPlano;
  readonly valorEmCentavos: number;
  /** Só `autorizada` renova sozinha. */
  readonly renovacaoAutomatica: boolean;
  readonly proximaCobranca: string | null;
  readonly meio: MeioDeCobranca | null;
  readonly ultimoPagamento: { readonly resultado: ResultadoDoPagamento; readonly em: string | null } | null;
  readonly renovacaoCanceladaEm: string | null;
}

export interface VisaoDePagamento {
  readonly habilitado: true;
  readonly ambiente: AmbienteDoGateway;
  readonly recorrencia: RecorrenciaVisivel | null;
  /** Há um checkout criado e ainda não confirmado: a tela mostra "processando". */
  readonly processando: boolean;
  /** Só conta com e-mail assina online: conta de chave de API não tem recibo nem aviso. */
  readonly contaComEmail: boolean;
  /**
   * O e-mail da PRÓPRIA conta, para a tela pré-preencher o campo do pagador (v0.49.5). Vai só na resposta
   * autenticada da conta dona dele; nunca para o /admin, log ou rota pública.
   */
  readonly emailDaConta: string | null;
}

/** O que o /admin mostra da última falha do gateway: quando, onde, o código e o motivo. Nada do pagador. */
export interface UltimaFalhaDoGateway {
  readonly em: Date;
  readonly operacao: string;
  readonly status: number | null;
  readonly codigo: string | null;
  readonly motivo: MotivoDoGateway;
}

/** Só um código curto e seguro do gateway (`bad_request`); qualquer outra coisa não entra na trilha. */
function codigoCurto(valor: string | undefined): string | undefined {
  return valor !== undefined && /^[A-Za-z0-9_.-]{1,40}$/.test(valor) ? valor : undefined;
}

export type EfeitoDoPagamento = 'renovou' | 'registrou' | 'repetido' | 'ignorado';

export interface ResultadoDaReconciliacao {
  readonly verificadas: number;
  readonly corrigidas: number;
  readonly pagamentosNovos: number;
  readonly falhas: number;
}

/**
 * Por que um plano NÃO pode ser contratado agora (ou `undefined` se pode). Uma regra só, usada pela
 * tela (botão ausente) e pela rota (recusa): plano sem preço não se contrata, plano fora de venda
 * também não, e só os ciclos de `CICLOS_VENDAVEIS` são vendáveis nesta versão.
 */
export function motivoDeNaoContratar(plano: Plano): MotivoDePagamentoRecusado | undefined {
  if (!plano.disponivelParaContratacao) return 'plano_nao_vendavel';
  if (!CICLOS_VENDAVEIS.includes(cicloDoPlano(plano))) return 'ciclo_nao_suportado';
  if (valorDoCicloEmCentavos(plano) === null) return 'plano_sem_preco';
  return undefined;
}

const FRASE_DO_MOTIVO: Readonly<Record<MotivoDePagamentoRecusado, string>> = {
  plano_sem_preco: 'Este plano ainda não tem preço publicado e não pode ser contratado pelo site.',
  plano_nao_vendavel: 'Este plano não está à venda.',
  ciclo_nao_suportado: 'Este plano tem um ciclo de renovação que ainda não pode ser contratado pelo site.',
  conta_sem_email: 'Esta conta não tem e-mail cadastrado; a assinatura online exige uma conta com e-mail.',
  ja_assinante:
    'Já existe uma assinatura com renovação automática ativa nesta conta. ' +
    'Para trocar de plano, cancele a renovação atual primeiro.',
  sem_recorrencia: 'Não há renovação automática para cancelar.',
  plano_desconhecido: 'Plano não encontrado.',
  termos_nao_aceitos: 'Para continuar, aceite os Termos de Uso.',
  plano_ja_vigente: 'Este plano já está vigente nesta conta.',
  email_do_pagador_invalido: 'Informe um e-mail válido para o pagamento.',
};

/** Teto do e-mail do pagador: o mesmo do cadastro (`corpoCadastro`/login: 200 caracteres). */
const TAMANHO_MAXIMO_DO_EMAIL = 200;

const mascara = (id: string): string => (id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : '…');
const brl = (centavos: number): string =>
  (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * A cobrança recorrente. O gateway cobra; este serviço só LIGA o que ele diz ao que o produto já faz.
 *
 * **O webhook é a única fonte de verdade — e nem ele fala por si.** Um aviso só dispara a consulta ao
 * gateway; o estado (autorizada, pausada, cancelada, aprovado, recusado, estornado) vem sempre da
 * consulta. O retorno do checkout (`back_url`) não decide nada: a tela mostra "processando" até o
 * servidor confirmar.
 *
 * **Um caminho só para dar acesso.** Pagamento aprovado chama `ServicoAssinaturas.liberar`, o MESMO
 * método do `assinatura liberar` manual: mesmas regras (carência vigente, renovação a partir do
 * vencimento, zerar a etapa de aviso), mesmos registros. Nada aqui calcula vencimento.
 *
 * **O acesso é das datas, não do gateway.** Cancelar a renovação, recusa de cartão e pausa NÃO derrubam
 * o plano: ele vale até o fim do período já pago, e a carência e os avisos de vencimento seguem como
 * sempre. Estorno e contestação NÃO revogam sozinhos: registram, avisam o operador e esperam a decisão
 * manual no /admin.
 *
 * Idempotente por construção: o pagamento é registrado com chave única ANTES de renovar, e só quem
 * registra renova — o mesmo aviso duas ou três vezes, ou fora de ordem, renova uma vez.
 */
export class ServicoPagamentos {
  private readonly gateway: GatewayDePagamento;
  private readonly repo: RepositorioPagamentos;
  private readonly planos: RepositorioPlanos;
  private readonly assinaturas: ServicoAssinaturas;
  private readonly usuarios: RepositorioUsuarios;
  private readonly logger: Logger;
  private readonly notificador: Notificador | undefined;
  private readonly urlBase: string;
  private readonly versaoDosTermos: string;
  private readonly emailDoOperador: string | undefined;
  private readonly agora: () => Date;
  private readonly gerarReferencia: () => string;

  constructor(opcoes: OpcoesServicoPagamentos) {
    this.gateway = opcoes.gateway;
    this.repo = opcoes.repositorio;
    this.planos = opcoes.planos;
    this.assinaturas = opcoes.assinaturas;
    this.usuarios = opcoes.usuarios;
    this.logger = opcoes.logger;
    this.notificador = opcoes.notificador;
    this.urlBase = opcoes.urlBase.replace(/\/+$/, '');
    this.versaoDosTermos = opcoes.versaoDosTermos;
    this.emailDoOperador = opcoes.emailDoOperador;
    this.agora = opcoes.agora ?? ((): Date => new Date());
    this.gerarReferencia = opcoes.gerarReferencia ?? ((): string => randomBytes(24).toString('hex'));
  }

  get ambiente(): AmbienteDoGateway {
    return this.gateway.ambiente;
  }

  get nomeDoGateway(): string {
    return this.gateway.nome;
  }

  // --- o que a conta vê --------------------------------------------------------------------------

  async visaoDe(workspace: string): Promise<VisaoDePagamento> {
    const c = await this.repo.maisRecenteDoWorkspace(workspace);
    const conta = await this.usuarios.porWorkspace(workspace);
    return {
      habilitado: true,
      ambiente: this.gateway.ambiente,
      contaComEmail: conta !== undefined,
      emailDaConta: conta?.email ?? null,
      recorrencia: c ? this.paraVisivel(c) : null,
      processando:
        c !== undefined &&
        c.estado === 'pendente' &&
        this.agora().getTime() - c.criadaEm.getTime() < JANELA_DO_CHECKOUT_EM_ABERTO_MS,
    };
  }

  /** A cobrança mais recente do workspace, para o /admin (que mostra mais que a conta). */
  async cobrancaDe(workspace: string): Promise<CobrancaRecorrente | undefined> {
    return this.repo.maisRecenteDoWorkspace(workspace);
  }

  /** Os aceites dos Termos do workspace (auditoria): versão, plano e data; nenhum dado pessoal. */
  async aceitesDe(workspace: string): Promise<readonly AceiteDeTermos[]> {
    return this.repo.aceitesDe(workspace);
  }

  async eventosDe(referencia: string): Promise<readonly EventoDePagamento[]> {
    return this.repo.eventosDe(referencia);
  }

  async todasAsCobrancas(): Promise<readonly CobrancaRecorrente[]> {
    return this.repo.todas();
  }

  // --- checkout ----------------------------------------------------------------------------------

  /**
   * Cria a recorrência no gateway e devolve a URL HOSPEDADA do checkout. O sistema não recebe nem
   * guarda dado de cartão; o e-mail do pagador vai ao gateway (que o exige) e NÃO é gravado aqui.
   *
   * @throws {PagamentoRecusadoError} antes de qualquer chamada ao gateway.
   * @throws {GatewayDePagamentoIndisponivelError | GatewayDePagamentoRecusouError}
   */
  async iniciarCheckout(opcoes: {
    readonly workspace: string;
    readonly plano: string;
    /** Obrigatório (v0.45.0): sem `true` nada é gravado nem enviado ao gateway. */
    readonly aceiteTermos?: boolean;
    /**
     * O e-mail com o qual a pessoa vai pagar no Mercado Pago (v0.49.5). O gateway recusa o pagamento quando o
     * e-mail de quem paga não é o da assinatura, então a pessoa o confirma na tela. Ausente = o e-mail da conta
     * (clientes antigos). Vai ao gateway como `payer_email` e NÃO é gravado, nem logado.
     */
    readonly emailDoPagador?: string;
  }): Promise<{ readonly urlDeCheckout: string }> {
    const plano = await this.planos.porCodigo(opcoes.plano);
    if (!plano) throw this.recusa('plano_desconhecido');
    const impedimento = motivoDeNaoContratar(plano);
    if (impedimento) throw this.recusa(impedimento);

    const conta = await this.usuarios.porWorkspace(opcoes.workspace);
    if (!conta) throw this.recusa('conta_sem_email');

    // Qualquer recorrência autorizada, de QUALQUER plano: um segundo checkout geraria uma segunda
    // cobrança recorrente em paralelo. A troca de plano não existe nesta versão.
    const atual = await this.repo.maisRecenteDoWorkspace(opcoes.workspace);
    if (atual?.estado === 'autorizada') throw this.recusa('ja_assinante');

    // Plano pago e vigente (liberação manual, Pix) do MESMO plano não abre checkout. O teste de 14 dias
    // não é assinatura ativa; carência e vencida também podem assinar (é a renovação).
    const vigente = await this.assinaturas.resumo(opcoes.workspace);
    if (vigente && vigente.status === 'ativa' && !vigente.ehTeste && vigente.plano === plano.codigo) {
      throw this.recusa('plano_ja_vigente');
    }

    // Por último entre as recusas, e ANTES de gravar ou chamar o gateway: sem o aceite não nasce nada.
    if (opcoes.aceiteTermos !== true) throw this.recusa('termos_nao_aceitos');

    const emailDoPagador = this.emailParaPagar(opcoes.emailDoPagador, conta.email);

    const valor = valorDoCicloEmCentavos(plano);
    if (valor === null) throw this.recusa('plano_sem_preco');
    const ciclo = cicloDoPlano(plano);
    const referencia = this.gerarReferencia();
    const agora = this.agora();

    // Um checkout novo SUBSTITUI o pendente: sem isso cada clique deixava mais uma assinatura viva no gateway.
    await this.substituirPendentes(opcoes.workspace);

    await this.repo.registrarAceiteDeTermos({
      workspace: opcoes.workspace,
      versao: this.versaoDosTermos,
      plano: plano.codigo,
      aceitoEm: agora,
    });

    // Grava ANTES de chamar o gateway: se o aviso do gateway chegar antes da nossa resposta, a
    // referência já existe e liga o aviso ao workspace.
    await this.repo.criar({
      referencia,
      workspace: opcoes.workspace,
      plano: plano.codigo,
      ciclo,
      valorEmCentavos: valor,
      gateway: this.gateway.nome,
      estado: 'pendente',
      criadaEm: agora,
      atualizadaEm: agora,
    });

    try {
      const criada = await this.gateway.criarAssinatura({
        referencia,
        motivo: `Processo Vivo — plano ${plano.nome}`,
        emailDoPagador,
        valorEmCentavos: valor,
        ciclo,
        urlDeRetorno: `${this.urlBase}/${QUERY_DE_RETORNO}`,
        urlDeNotificacao: `${this.urlBase}${ROTA_DO_WEBHOOK_MERCADO_PAGO}`,
        chaveDeIdempotencia: referencia,
      });
      const c = await this.repo.porReferencia(referencia);
      if (c) {
        await this.repo.atualizar({
          ...c,
          gatewayId: criada.id,
          estado: criada.estado,
          atualizadaEm: this.agora(),
        });
      }
      await this.evento('checkout_criado', { workspace: opcoes.workspace, referencia }, `plano ${plano.codigo}, ${brl(valor)}`);
      this.logger.info('checkout de assinatura criado', { plano: plano.codigo, gateway: this.gateway.nome });
      return { urlDeCheckout: criada.urlDeCheckout };
    } catch (erro) {
      // A criação não aconteceu (ou não se sabe): a linha vira "cancelada" para não ficar pendente
      // para sempre. Se o gateway chegou a criar, um aviso futuro a localiza pela referência.
      const c = await this.repo.porReferencia(referencia);
      if (c) {
        await this.repo.atualizar({ ...c, estado: 'cancelada', renovacaoCanceladaEm: this.agora(), atualizadaEm: this.agora() });
      }
      await this.evento('checkout_falhou', { workspace: opcoes.workspace, referencia });
      await this.registrarFalhaDoGateway('criarAssinatura', erro, { workspace: opcoes.workspace, referencia });
      throw erro;
    }
  }

  /**
   * O e-mail que vai como `payer_email`: o informado (aparado, na mesma regra do cadastro, até 200) ou, se a
   * tela antiga não mandou nada, o da conta. Recusa ANTES de gravar ou chamar o gateway, sem repetir o valor.
   */
  private emailParaPagar(informado: string | undefined, daConta: string): string {
    if (informado === undefined) return daConta;
    const aparado = informado.trim();
    if (aparado === '' || aparado.length > TAMANHO_MAXIMO_DO_EMAIL) {
      throw this.recusa('email_do_pagador_invalido');
    }
    try {
      return normalizarEmail(aparado);
    } catch (erro) {
      if (erro instanceof EmailInvalidoError) throw this.recusa('email_do_pagador_invalido');
      throw erro;
    }
  }

  /**
   * Antes de abrir um checkout novo, encerra os pendentes da conta (o do e-mail errado, por exemplo) no
   * gateway, para nunca haver duas assinaturas vivas. Três cuidados: (1) se o gateway diz que o pendente JÁ
   * foi autorizado, a conta já assinou — sincroniza e recusa (`ja_assinante`) em vez de cancelar o que foi
   * pago; (2) falha ao consultar ou cancelar NÃO impede o checkout novo: registra a falha (sem dado pessoal)
   * e deixa a linha `pendente` para a reconciliação; (3) pendente sem id no gateway (a criação nunca
   * terminou) só é encerrado aqui.
   */
  private async substituirPendentes(workspace: string): Promise<void> {
    for (const antiga of await this.repo.pendentesDoWorkspace(workspace)) {
      if (!antiga.gatewayId) {
        await this.encerrarLocalmente(antiga);
        continue;
      }
      try {
        const remota = await this.gateway.consultarAssinatura(antiga.gatewayId);
        if (remota.estado === 'autorizada') {
          await this.sincronizarAssinatura(antiga.gatewayId);
          throw this.recusa('ja_assinante');
        }
      } catch (erro) {
        if (erro instanceof PagamentoRecusadoError) throw erro;
        await this.registrarFalhaDoGateway('consultarAssinatura', erro, { workspace, referencia: antiga.referencia });
        // Sem saber o estado dela, não se cancela: fica para a reconciliação.
        await this.evento('pendente_nao_substituida', { workspace, referencia: antiga.referencia });
        continue;
      }
      try {
        await this.gateway.cancelarAssinatura(antiga.gatewayId);
      } catch (erro) {
        await this.registrarFalhaDoGateway('cancelarAssinatura', erro, { workspace, referencia: antiga.referencia });
        await this.evento('pendente_nao_substituida', { workspace, referencia: antiga.referencia });
        continue;
      }
      await this.encerrarLocalmente(antiga);
      await this.evento('checkout_substituido', { workspace, referencia: antiga.referencia });
    }
  }

  private async encerrarLocalmente(c: CobrancaRecorrente): Promise<void> {
    const agora = this.agora();
    await this.repo.atualizar({ ...c, estado: 'cancelada', renovacaoCanceladaEm: agora, atualizadaEm: agora });
  }

  // --- a última falha do gateway (para o /admin) -------------------------------------------------

  /**
   * Guarda NA TRILHA o que falhou com o gateway: operação, status, motivo (lista fechada) e o código curto
   * do gateway. Nunca o texto dele (pode ecoar o e-mail do pagador), nunca o pedido. Só falha do
   * gateway entra aqui; erro nosso segue para o handler de erro como sempre.
   */
  private async registrarFalhaDoGateway(
    operacao: string,
    erro: unknown,
    quem: { workspace?: string; referencia?: string },
  ): Promise<void> {
    let status: number | undefined;
    let motivo: MotivoDoGateway;
    let codigo: string | undefined;
    if (erro instanceof GatewayDePagamentoRecusouError) {
      status = erro.status;
      motivo = erro.motivoDoGateway;
      codigo = codigoCurto(erro.diagnostico?.erro) ?? codigoCurto(erro.diagnostico?.causas[0]?.codigo);
    } else if (erro instanceof GatewayDePagamentoIndisponivelError) {
      motivo = 'indisponivel';
    } else {
      return;
    }
    await this.evento(
      'gateway_falhou',
      quem,
      `operacao=${operacao} status=${status ?? '-'} motivo=${motivo} codigo=${codigo ?? '-'}`,
    );
  }

  /** A falha mais recente do gateway, de qualquer conta, ou `undefined` se nunca houve. */
  async ultimaFalhaDoGateway(): Promise<UltimaFalhaDoGateway | undefined> {
    const e = await this.repo.ultimoEventoDoTipo('gateway_falhou');
    if (!e?.detalhe) return undefined;
    const campo = (nome: string): string | undefined => new RegExp(`${nome}=(\\S+)`).exec(e.detalhe ?? '')?.[1];
    const status = campo('status');
    const codigo = campo('codigo');
    return {
      em: e.criadoEm,
      operacao: campo('operacao') ?? '-',
      status: status && status !== '-' ? Number(status) : null,
      codigo: codigo && codigo !== '-' ? codigo : null,
      motivo: (campo('motivo') as MotivoDoGateway | undefined) ?? 'desconhecido',
    };
  }

  // --- cancelar a renovação ----------------------------------------------------------------------

  /**
   * Encerra a RENOVAÇÃO automática no gateway. O plano continua valendo até o fim do período já pago
   * (nada aqui mexe em `Assinatura`) e o evento fica registrado para auditoria.
   *
   * @throws {PagamentoRecusadoError} `sem_recorrencia`.
   */
  async cancelarRecorrencia(workspace: string): Promise<VisaoDePagamento> {
    const c = await this.repo.maisRecenteDoWorkspace(workspace);
    if (!c || !['pendente', 'autorizada', 'pausada'].includes(c.estado)) {
      throw this.recusa('sem_recorrencia');
    }
    if (c.gatewayId) {
      try {
        await this.gateway.cancelarAssinatura(c.gatewayId);
      } catch (erro) {
        await this.registrarFalhaDoGateway('cancelarAssinatura', erro, { workspace, referencia: c.referencia });
        throw erro;
      }
    }
    const agora = this.agora();
    await this.repo.atualizar({ ...c, estado: 'cancelada', renovacaoCanceladaEm: agora, atualizadaEm: agora });
    await this.evento('renovacao_cancelada_pelo_usuario', { workspace, referencia: c.referencia });
    this.logger.info('renovação automática cancelada pela conta', { gateway: this.gateway.nome });
    return this.visaoDe(workspace);
  }

  // --- avisos do gateway -------------------------------------------------------------------------

  /** Confere a assinatura do aviso (sem rede). @throws {AssinaturaDeWebhookInvalidaError} */
  validarAviso(entrada: Parameters<GatewayDePagamento['validarWebhook']>[0]): EventoDeWebhook {
    return this.gateway.validarWebhook(entrada);
  }

  /**
   * Trata um aviso JÁ VALIDADO: consulta o gateway pelo id e só então muda o estado. Falha do
   * gateway sobe como erro (o aviso volta a chegar em 15 minutos, e o tratamento é idempotente).
   */
  async processarAviso(evento: EventoDeWebhook): Promise<void> {
    if (evento.topico === 'assinatura') {
      await this.sincronizarAssinatura(evento.recursoId);
    } else if (evento.topico === 'cobranca') {
      await this.aplicarPagamento(await this.gateway.consultarCobranca(evento.recursoId), 'cobranca');
    } else if (evento.topico === 'pagamento') {
      await this.aplicarPagamento(await this.gateway.consultarPagamento(evento.recursoId), 'pagamento');
    } else {
      this.logger.debug('aviso de pagamento de outro tópico ignorado');
    }
  }

  /**
   * Consulta cada recorrência aberta e corrige o que divergir — para o caso de um aviso perdido. Uma
   * falha numa conta não interrompe as outras. Sem agendador: é comando (CLI) e botão (/admin).
   */
  async reconciliar(opcoes: { readonly workspace?: string } = {}): Promise<ResultadoDaReconciliacao> {
    const abertas = (await this.repo.abertas()).filter(
      (c) => opcoes.workspace === undefined || c.workspace === opcoes.workspace,
    );
    let corrigidas = 0;
    let pagamentosNovos = 0;
    let falhas = 0;
    for (const c of abertas) {
      if (!c.gatewayId) continue;
      try {
        if (await this.sincronizarAssinatura(c.gatewayId)) corrigidas++;
        for (const p of await this.gateway.listarCobrancasDaAssinatura(c.gatewayId)) {
          const efeito = await this.aplicarPagamento({ ...p, assinaturaId: c.gatewayId }, 'cobranca');
          if (efeito === 'renovou' || efeito === 'registrou') pagamentosNovos++;
        }
      } catch (erro) {
        falhas++;
        await this.registrarFalhaDoGateway('reconciliar', erro, { workspace: c.workspace, referencia: c.referencia });
        this.logger.warn('reconciliação de uma assinatura falhou', {
          gateway: this.gateway.nome,
          causa: erro instanceof Error ? erro.name : 'erro',
        });
      }
    }
    await this.evento('reconciliacao', {}, `${abertas.length} verificadas, ${corrigidas} corrigidas, ${pagamentosNovos} pagamentos novos, ${falhas} falhas`);
    return { verificadas: abertas.length, corrigidas, pagamentosNovos, falhas };
  }

  // --- internos ----------------------------------------------------------------------------------

  /** Devolve `true` se algo mudou na nossa cópia. */
  private async sincronizarAssinatura(gatewayId: string): Promise<boolean> {
    const remota = await this.gateway.consultarAssinatura(gatewayId);
    let c = await this.repo.porGatewayId(gatewayId);
    if (!c && remota.referencia) {
      c = await this.repo.porReferencia(remota.referencia);
      if (c && !c.gatewayId) c = { ...c, gatewayId };
    }
    if (!c) {
      this.logger.info('aviso de assinatura que não é nossa: ignorado', { gateway: this.gateway.nome });
      return false;
    }
    const mudou =
      c.estado !== remota.estado ||
      c.gatewayId !== gatewayId ||
      (remota.proximaCobranca?.getTime() ?? 0) !== (c.proximaCobranca?.getTime() ?? 0);
    if (!mudou) return false;

    const anterior = c.estado;
    const encerrou = remota.estado === 'cancelada' || remota.estado === 'pausada';
    const agora = this.agora();
    await this.repo.atualizar({
      ...c,
      gatewayId,
      estado: remota.estado,
      ...(remota.proximaCobranca ? { proximaCobranca: remota.proximaCobranca } : {}),
      ...(encerrou && !c.renovacaoCanceladaEm ? { renovacaoCanceladaEm: agora } : {}),
      atualizadaEm: agora,
    });
    await this.evento(`assinatura_${remota.estado}`, { workspace: c.workspace, referencia: c.referencia });

    // Foi o GATEWAY que encerrou (cartão recusado 3 vezes, pausa, cancelamento pelo painel dele):
    // a conta precisa saber, porque a partir daqui nada renova sozinho. O acesso segue até a vigência.
    if (encerrou && anterior !== remota.estado && anterior !== 'cancelada') {
      await this.avisarRenovacaoEncerrada(c.workspace);
    }
    return true;
  }

  private async aplicarPagamento(
    p: PagamentoNoGateway,
    origem: 'cobranca' | 'pagamento',
  ): Promise<EfeitoDoPagamento> {
    const c = await this.localizar(p);
    if (!c) {
      this.logger.info('pagamento de assinatura que não é nossa: ignorado', { gateway: this.gateway.nome });
      return 'ignorado';
    }
    const agora = this.agora();
    const base = { workspace: c.workspace, referencia: c.referencia };

    if (p.resultado === 'aprovado') {
      const novo = await this.repo.registrarPagamento({
        chave: p.id,
        referencia: c.referencia,
        workspace: c.workspace,
        resultado: 'aprovado',
        valorEmCentavos: p.valorEmCentavos,
        ...(p.ocorridoEm ? { ocorridoEm: p.ocorridoEm } : {}),
        registradoEm: agora,
      });
      if (!novo) return 'repetido';
      try {
        // O MESMO caminho do `assinatura liberar`: plano e ciclo vêm do que foi contratado.
        await this.assinaturas.liberar({
          workspace: c.workspace,
          plano: c.plano,
          meses: MESES_POR_CICLO[c.ciclo],
          observacao: `Cobrança recorrente (${this.gateway.nome})`,
        });
      } catch (erro) {
        // Sem renovar, o registro não pode ficar: o aviso repetido precisa poder tentar de novo.
        await this.repo.desfazerRegistro(p.id);
        throw erro;
      }
      await this.repo.atualizar({
        ...c,
        // Pagamento aprovado numa recorrência pendente é a prova de que ela foi autorizada.
        estado: c.estado === 'pendente' ? 'autorizada' : c.estado,
        ...(p.meio ? { meio: p.meio } : {}),
        ultimoPagamento: 'aprovado',
        ultimoPagamentoEm: p.ocorridoEm ?? agora,
        atualizadaEm: agora,
      });
      await this.evento('pagamento_aprovado', base, brl(p.valorEmCentavos));
      return 'renovou';
    }

    if (p.resultado === 'recusado') {
      // Só a PARCELA fala de recusa: o tópico de pagamento chega em paralelo e dobraria o aviso.
      if (origem !== 'cobranca') return 'ignorado';
      const novo = await this.repo.registrarPagamento({
        chave: p.id,
        referencia: c.referencia,
        workspace: c.workspace,
        resultado: 'recusado',
        valorEmCentavos: p.valorEmCentavos,
        ...(p.ocorridoEm ? { ocorridoEm: p.ocorridoEm } : {}),
        registradoEm: agora,
      });
      if (!novo) return 'repetido';
      await this.repo.atualizar({ ...c, ultimoPagamento: 'recusado', ultimoPagamentoEm: p.ocorridoEm ?? agora, atualizadaEm: agora });
      await this.evento('pagamento_recusado', base, brl(p.valorEmCentavos));
      await this.avisarFalhaDePagamento(c.workspace);
      return 'registrou';
    }

    if (p.resultado === 'estornado' || p.resultado === 'contestado') {
      const existente = await this.repo.pagamentoPorChave(p.id);
      if (existente?.resultado === p.resultado) return 'repetido';
      if (existente) {
        await this.repo.atualizarResultado(p.id, p.resultado);
      } else {
        // O estorno chegou antes da aprovação (fora de ordem): fica registrado, e a aprovação
        // que vier depois acha a chave ocupada e NÃO renova um pagamento já devolvido.
        await this.repo.registrarPagamento({
          chave: p.id,
          referencia: c.referencia,
          workspace: c.workspace,
          resultado: p.resultado,
          valorEmCentavos: p.valorEmCentavos,
          ...(p.ocorridoEm ? { ocorridoEm: p.ocorridoEm } : {}),
          registradoEm: agora,
        });
      }
      await this.repo.atualizar({ ...c, ultimoPagamento: p.resultado, ultimoPagamentoEm: p.ocorridoEm ?? agora, atualizadaEm: agora });
      await this.evento(`pagamento_${p.resultado}`, base, brl(p.valorEmCentavos));
      // NÃO revoga: a decisão é do operador, no /admin.
      await this.avisarOperador(c, p.resultado, p.valorEmCentavos);
      return 'registrou';
    }

    return 'ignorado'; // pendente: nada a fazer até virar outra coisa
  }

  private async localizar(p: PagamentoNoGateway): Promise<CobrancaRecorrente | undefined> {
    if (p.assinaturaId) {
      const c = await this.repo.porGatewayId(p.assinaturaId);
      if (c) return c;
    }
    if (p.referencia) return this.repo.porReferencia(p.referencia);
    return undefined;
  }

  private paraVisivel(c: CobrancaRecorrente): RecorrenciaVisivel {
    return {
      estado: c.estado,
      plano: c.plano,
      ciclo: c.ciclo,
      valorEmCentavos: c.valorEmCentavos,
      renovacaoAutomatica: c.estado === 'autorizada',
      proximaCobranca: c.proximaCobranca?.toISOString() ?? null,
      meio: c.meio ?? null,
      ultimoPagamento: c.ultimoPagamento
        ? { resultado: c.ultimoPagamento, em: c.ultimoPagamentoEm?.toISOString() ?? null }
        : null,
      renovacaoCanceladaEm: c.renovacaoCanceladaEm?.toISOString() ?? null,
    };
  }

  private recusa(motivo: MotivoDePagamentoRecusado): PagamentoRecusadoError {
    return new PagamentoRecusadoError(motivo, FRASE_DO_MOTIVO[motivo]);
  }

  private async evento(
    tipo: string,
    quem: { workspace?: string; referencia?: string },
    detalhe?: string,
  ): Promise<void> {
    await this.repo.registrarEvento({
      ...(quem.workspace ? { workspace: quem.workspace } : {}),
      ...(quem.referencia ? { referencia: quem.referencia } : {}),
      tipo,
      ...(detalhe ? { detalhe } : {}),
      criadoEm: this.agora(),
    });
  }

  // --- e-mails -----------------------------------------------------------------------------------
  // Sem dado do cartão, sem valor do gateway no texto, sem nome. Falha de envio nunca derruba o fluxo.

  private async validoAte(workspace: string): Promise<string> {
    const a = await this.assinaturas.doWorkspace(workspace);
    return a ? a.venceEm.toLocaleDateString('pt-BR') : 'o fim do período já pago';
  }

  private async avisarFalhaDePagamento(workspace: string): Promise<void> {
    const conta = await this.usuarios.porWorkspace(workspace);
    if (!conta || !this.notificador?.habilitado) return;
    await this.notificador.enviar({
      para: conta.email,
      assunto: 'Processo Vivo — não conseguimos cobrar a renovação',
      texto: [
        'A cobrança da renovação da sua assinatura não foi aprovada.',
        '',
        'O Mercado Pago pode tentar de novo nos próximos dias. Para evitar interrupção, confira',
        'o cartão usado na assinatura (limite, validade, dados).',
        '',
        `Seu plano continua valendo até ${await this.validoAte(workspace)}.`,
      ].join('\n'),
    });
  }

  private async avisarRenovacaoEncerrada(workspace: string): Promise<void> {
    const conta = await this.usuarios.porWorkspace(workspace);
    if (!conta || !this.notificador?.habilitado) return;
    await this.notificador.enviar({
      para: conta.email,
      assunto: 'Processo Vivo — a renovação automática foi encerrada',
      texto: [
        'A renovação automática da sua assinatura foi encerrada pelo Mercado Pago.',
        '',
        `Seu plano continua valendo até ${await this.validoAte(workspace)}. Depois disso a`,
        'vigilância dos seus processos para, e NÃO receber e-mail nosso deixa de significar que',
        'nada aconteceu.',
        '',
        'Para continuar, assine de novo pela tela do plano.',
      ].join('\n'),
    });
  }

  private async avisarOperador(
    c: CobrancaRecorrente,
    resultado: ResultadoDoPagamento,
    valorEmCentavos: number,
  ): Promise<void> {
    this.logger.warn('pagamento estornado ou contestado: decisão manual no /admin', {
      workspace: mascara(c.workspace),
      resultado,
    });
    if (!this.emailDoOperador || !this.notificador?.habilitado) return;
    await this.notificador.enviar({
      para: this.emailDoOperador,
      assunto: `Processo Vivo — pagamento ${resultado === 'estornado' ? 'estornado' : 'contestado'}`,
      texto: [
        `Um pagamento de ${brl(valorEmCentavos)} foi ${resultado === 'estornado' ? 'estornado' : 'contestado'}.`,
        `Conta (mascarada): ${mascara(c.workspace)} — plano ${c.plano}.`,
        '',
        'O sistema NÃO revogou o acesso. Decida no /admin (assinatura da conta).',
      ].join('\n'),
    });
  }
}
