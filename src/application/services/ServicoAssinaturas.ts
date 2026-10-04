import { Assinatura, assinaturaDeTeste } from '../../domain/entities/Assinatura.js';
import type { StatusAssinatura } from '../../domain/entities/Assinatura.js';
import {
  descricaoDoRecurso,
  menorPlanoCom,
  ordenarPlanos,
  planoInclui,
} from '../../domain/entities/Plano.js';
import type { CodigoPlano, Plano, RecursoDoPlano } from '../../domain/entities/Plano.js';
import {
  AssinaturaInativaError,
  PlanoDesconhecidoError,
  RecursoNaoIncluidoNoPlanoError,
} from '../../domain/errors/index.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { Notificador } from '../../domain/ports/Notificador.js';
import type {
  EtapaDeAviso,
  RepositorioAssinaturas,
} from '../../domain/ports/RepositorioAssinaturas.js';
import type {
  RepositorioPlanos,
  RepositorioRegrasDeAssinatura,
} from '../../domain/ports/RepositorioPlanos.js';
import type { RepositorioUsuarios } from '../../domain/ports/RepositorioUsuarios.js';

/** Quantos dias antes do vencimento o primeiro aviso sai. */
export const DIAS_DE_ANTECEDENCIA_DO_AVISO = 3;

export interface ResumoAssinatura {
  readonly plano: CodigoPlano;
  readonly nomeDoPlano: string;
  readonly status: StatusAssinatura;
  readonly venceEm: string;
  readonly diasParaVencer: number;
  readonly recursos: readonly RecursoDoPlano[];
  /** Os mesmos recursos, com o nome que a pessoa entende. */
  readonly nomesDosRecursos: readonly string[];
  /** `null` quando o plano não tem preço publicado. */
  readonly precoMensalCentavos: number | null;
  readonly ehTeste: boolean;
  /** Frase pronta para a tela. A interface não deve montar a sua própria. */
  readonly aviso?: string;
}

export interface OpcoesServicoAssinaturas {
  readonly repositorio: RepositorioAssinaturas;
  /** O catálogo de planos — de onde sai o que cada código de plano inclui. */
  readonly planos: RepositorioPlanos;
  /** Dias de teste, plano do teste e carência — editáveis pelo painel. */
  readonly regras: RepositorioRegrasDeAssinatura;
  readonly usuarios: RepositorioUsuarios;
  readonly logger: Logger;
  /** Sem notificador, os avisos não saem — e o log diz isso alto. */
  readonly notificador?: Notificador;
  readonly agora?: () => Date;
}

/**
 * Assinaturas: quem pode usar o quê, e quem precisa ser avisado.
 *
 * **A regra que molda este serviço:** um workspace SEM assinatura não é
 * bloqueado. Parece frouxo e é deliberado — workspace de chave de API não tem
 * conta e nunca terá assinatura, e esses são os fluxos de integração do
 * próprio operador. Tratar ausência como bloqueio derrubaria o n8n no dia do
 * deploy, sem que ninguém tivesse comprado nada. O que garante que assinante
 * de verdade tenha assinatura é a retrocarga no arranque e o teste criado no
 * cadastro, não uma negativa por omissão aqui.
 */
export class ServicoAssinaturas {
  private readonly repositorio: RepositorioAssinaturas;
  private readonly planos: RepositorioPlanos;
  private readonly regras: RepositorioRegrasDeAssinatura;
  private readonly usuarios: RepositorioUsuarios;
  private readonly logger: Logger;
  private readonly notificador: Notificador | undefined;
  private readonly agora: () => Date;

  constructor(opcoes: OpcoesServicoAssinaturas) {
    this.repositorio = opcoes.repositorio;
    this.planos = opcoes.planos;
    this.regras = opcoes.regras;
    this.usuarios = opcoes.usuarios;
    this.logger = opcoes.logger;
    this.notificador = opcoes.notificador;
    this.agora = opcoes.agora ?? ((): Date => new Date());
  }

  async doWorkspace(workspace: string): Promise<Assinatura | undefined> {
    return this.repositorio.porWorkspace(workspace);
  }

  /**
   * O plano a que a assinatura aponta.
   *
   * Um código sem plano no catálogo só acontece com banco editado à mão —
   * não há remoção de plano. Vira erro nomeado aqui, e não um "plano
   * undefined" circulando até estourar longe da causa.
   *
   * @throws {PlanoDesconhecidoError}
   */
  async planoDe(assinatura: Assinatura): Promise<Plano> {
    const plano = await this.planos.porCodigo(assinatura.plano);
    if (plano) return plano;
    const todos = ordenarPlanos(await this.planos.listar());
    throw new PlanoDesconhecidoError(assinatura.plano, todos.map((p) => p.codigo));
  }

  /**
   * Barra o acesso, ou não faz nada.
   *
   * Lança dois erros DIFERENTES de propósito: "seu plano não inclui" e "sua
   * assinatura venceu" pedem ações opostas — trocar de plano e pagar o que já
   * foi contratado. Uma mensagem só para os dois manda metade das pessoas
   * fazer a coisa errada.
   */
  async exigir(workspace: string, recurso: RecursoDoPlano): Promise<void> {
    const assinatura = await this.repositorio.porWorkspace(workspace);
    if (!assinatura) return;

    const agora = this.agora();
    if (!assinatura.estaVigenteEm(agora)) {
      throw new AssinaturaInativaError(assinatura.statusEm(agora));
    }
    const plano = await this.planoDe(assinatura);
    if (!planoInclui(plano, recurso)) {
      const sugerido = menorPlanoCom(await this.planos.listar(), recurso);
      throw new RecursoNaoIncluidoNoPlanoError(
        descricaoDoRecurso(recurso).frase,
        plano.nome,
        sugerido?.nome,
      );
    }
  }

  /** O teste de conta nova. Chamado pelo cadastro, nunca por rota pública. */
  async criarTeste(workspace: string): Promise<Assinatura> {
    const regras = await this.regras.ler();
    const teste = assinaturaDeTeste({
      workspace,
      plano: regras.planoDoTeste,
      dias: regras.diasDeTeste,
      agora: this.agora(),
    });
    await this.repositorio.salvar(teste);
    return teste;
  }

  /**
   * Liberação manual, depois do Pix. Cria se não existe, renova se existe.
   *
   * A carência gravada é a das regras VIGENTES na hora da liberação — mudar a
   * carência no painel vale a partir da próxima liberação de cada assinante,
   * nunca retroativamente.
   *
   * Plano pausado (fora de venda) PODE ser liberado: é como se mantém um
   * cliente antigo no plano que ele tinha, ou se faz um piloto. Quem avisa
   * isso é a interface (o CLI imprime ATENÇÃO; o painel marca "pausado").
   *
   * @throws {PlanoDesconhecidoError}
   */
  async liberar(opcoes: {
    readonly workspace: string;
    readonly plano: CodigoPlano;
    readonly meses: number;
    readonly observacao?: string;
  }): Promise<Assinatura> {
    if (!(await this.planos.porCodigo(opcoes.plano))) {
      const todos = ordenarPlanos(await this.planos.listar());
      throw new PlanoDesconhecidoError(opcoes.plano, todos.map((p) => p.codigo));
    }
    const { diasDeCarencia } = await this.regras.ler();
    const agora = this.agora();
    const atual = await this.repositorio.porWorkspace(opcoes.workspace);

    const nova = atual
      ? atual.renovada({
          plano: opcoes.plano,
          meses: opcoes.meses,
          agora,
          diasDeCarencia,
          ...(opcoes.observacao !== undefined ? { observacao: opcoes.observacao } : {}),
        })
      : (() => {
          const fim = new Date(agora.getTime());
          fim.setMonth(fim.getMonth() + opcoes.meses);
          return new Assinatura({
            workspace: opcoes.workspace,
            plano: opcoes.plano,
            inicioEm: agora,
            venceEm: fim,
            ehTeste: false,
            diasDeCarencia,
            ...(opcoes.observacao !== undefined ? { observacao: opcoes.observacao } : {}),
          });
        })();

    await this.repositorio.salvar(nova);
    this.logger.info('assinatura liberada', {
      workspace: opcoes.workspace,
      plano: nova.plano,
      venceEm: nova.venceEm.toISOString(),
    });
    return nova;
  }

  async cancelar(
    workspace: string,
    observacao?: string,
  ): Promise<Assinatura | undefined> {
    const atual = await this.repositorio.porWorkspace(workspace);
    if (!atual) return undefined;

    const cancelada = atual.cancelada(this.agora(), observacao);
    await this.repositorio.salvar(cancelada);
    this.logger.info('assinatura cancelada', { workspace });
    return cancelada;
  }

  async resumo(workspace: string): Promise<ResumoAssinatura | undefined> {
    const a = await this.repositorio.porWorkspace(workspace);
    if (!a) return undefined;

    const plano = await this.planoDe(a);
    const agora = this.agora();
    const status = a.statusEm(agora);
    const aviso = fraseDeAviso(a, status, agora);

    return {
      plano: a.plano,
      nomeDoPlano: plano.nome,
      status,
      venceEm: a.venceEm.toISOString(),
      diasParaVencer: a.diasParaVencer(agora),
      recursos: plano.recursos,
      nomesDosRecursos: plano.recursos.map((r) => descricaoDoRecurso(r).nome),
      precoMensalCentavos: plano.precoMensalCentavos,
      ehTeste: a.ehTeste,
      ...(aviso ? { aviso } : {}),
    };
  }

  /**
   * Varre e avisa. Uma passagem por etapa, nunca duas.
   *
   * **Esta é a obrigação que o produto não pode quebrar.** A partir do
   * primeiro aviso de movimentação enviado, o advogado para de conferir à mão
   * e passa a ler silêncio como "não houve nada". Se a vigilância parar porque
   * a assinatura caiu e ninguém disser, o silêncio continua parecendo
   * tranquilidade — e é exatamente assim que se perde prazo. O mesmo princípio
   * que já governa `ServicoNotificacao`.
   */
  async avisarVencimentos(): Promise<{ avisados: number }> {
    const agora = this.agora();
    const limite = new Date(agora.getTime() + DIAS_DE_ANTECEDENCIA_DO_AVISO * 86_400_000);
    const candidatas = await this.repositorio.aVencerAte(limite);

    if (!this.notificador?.habilitado) {
      if (candidatas.length > 0) {
        // Alto no log de propósito: assinatura caindo sem canal de aviso é uma
        // promessa quebrada em silêncio, não um detalhe de configuração.
        this.logger.warn('assinaturas a vencer e nenhum canal de aviso configurado', {
          quantidade: candidatas.length,
        });
      }
      return { avisados: 0 };
    }

    // O catálogo uma vez por varredura, não uma consulta por e-mail.
    const nomes = new Map((await this.planos.listar()).map((p) => [p.codigo, p.nome]));

    let avisados = 0;
    for (const a of candidatas) {
      const etapa = etapaDe(a, agora);
      if (!etapa) continue;
      if ((await this.repositorio.ultimoAviso(a.workspace)) === etapa) continue;

      const conta = await this.usuarios.porWorkspace(a.workspace);
      if (!conta) continue;

      const enviado = await this.notificador.enviar({
        para: conta.email,
        assunto: assuntoDoAviso(etapa, a),
        texto: textoDoAviso(etapa, a, agora, nomes.get(a.plano) ?? a.plano),
      });

      // Só marca depois de confirmar o envio. Marcar antes transformaria uma
      // falha de SMTP em "já avisamos" — e aí o assinante nunca mais recebe
      // este aviso, porque a etapa não volta.
      if (enviado) {
        await this.repositorio.registrarAviso(a.workspace, etapa);
        avisados++;
      }
    }

    if (avisados > 0) this.logger.info('avisos de assinatura enviados', { avisados });
    return { avisados };
  }
}

function etapaDe(a: Assinatura, agora: Date): EtapaDeAviso | undefined {
  const status = a.statusEm(agora);
  if (status === 'carencia') return 'carencia';
  if (status === 'vencida') return 'bloqueada';
  if (
    (status === 'ativa' || status === 'teste') &&
    a.diasParaVencer(agora) <= DIAS_DE_ANTECEDENCIA_DO_AVISO
  ) {
    return 'vencendo';
  }
  return undefined;
}

function assuntoDoAviso(etapa: EtapaDeAviso, a: Assinatura): string {
  if (etapa === 'vencendo') {
    return a.ehTeste
      ? 'Processo Vivo — seu teste está acabando'
      : 'Processo Vivo — sua assinatura vence em breve';
  }
  if (etapa === 'carencia') return 'Processo Vivo — sua assinatura venceu';
  return 'Processo Vivo — a vigilância dos seus processos foi PARADA';
}

function textoDoAviso(
  etapa: EtapaDeAviso,
  a: Assinatura,
  agora: Date,
  plano: string,
): string {
  if (etapa === 'vencendo') {
    const dias = Math.max(a.diasParaVencer(agora), 0);
    const prazo = dias <= 0 ? 'hoje' : dias === 1 ? 'amanhã' : `em ${dias} dias`;
    return a.ehTeste
      ? [
          `Seu teste do plano ${plano} termina ${prazo}.`,
          '',
          'Depois disso a vigilância dos seus processos PARA, e você deixa de',
          'receber os avisos de movimentação. Seus dados continuam aqui.',
          '',
          'Para continuar, responda este e-mail que a gente resolve.',
        ].join('\n')
      : [
          `Sua assinatura do plano ${plano} vence ${prazo}.`,
          '',
          'Nada muda no vencimento: há ainda alguns dias de carência com tudo',
          'funcionando normalmente. Este e-mail é para você não ser pego de',
          'surpresa.',
          '',
          'Para renovar, responda este e-mail.',
        ].join('\n');
  }

  if (etapa === 'carencia') {
    return [
      `Sua assinatura do plano ${plano} venceu.`,
      '',
      'A vigilância dos seus processos CONTINUA funcionando durante o período',
      `de carência, que termina em ${a.fimDaCarencia.toLocaleDateString('pt-BR')}.`,
      '',
      'Depois dessa data as consultas e a vigilância param, e você deixa de',
      'receber aviso de movimentação. Seus dados continuam aqui.',
      '',
      'Para regularizar, responda este e-mail.',
    ].join('\n');
  }

  return [
    'A vigilância dos seus processos foi PARADA porque a assinatura venceu e o',
    'prazo de carência terminou.',
    '',
    'O que isso significa na prática: a partir de agora, NÃO receber e-mail',
    'nosso não quer dizer que não houve movimentação. Confira seus prazos',
    'diretamente no tribunal enquanto a assinatura estiver parada.',
    '',
    'Seus processos, seu histórico e suas configurações continuam guardados.',
    'Reativando, tudo volta como estava.',
    '',
    'Para reativar, responda este e-mail.',
  ].join('\n');
}

function fraseDeAviso(
  a: Assinatura,
  status: StatusAssinatura,
  agora: Date,
): string | undefined {
  if (status === 'cancelada') return 'Assinatura cancelada. A vigilância está parada.';
  if (status === 'vencida') {
    return 'Assinatura vencida e fora da carência. A vigilância está parada — confira seus prazos no tribunal.';
  }
  if (status === 'carencia') {
    return `Assinatura vencida. Tudo continua funcionando até ${a.fimDaCarencia.toLocaleDateString('pt-BR')}.`;
  }

  const dias = a.diasParaVencer(agora);
  if (dias > DIAS_DE_ANTECEDENCIA_DO_AVISO) return undefined;
  const prazo = dias <= 0 ? 'hoje' : dias === 1 ? 'amanhã' : `em ${dias} dias`;
  return a.ehTeste ? `Seu teste termina ${prazo}.` : `Sua assinatura vence ${prazo}.`;
}
