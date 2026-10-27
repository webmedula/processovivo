import {
  ABAS_DO_ADMIN,
  ROTULO_DA_ABA,
  abasEmOrdem,
  ehAbaDoAdmin,
  type AbaDoAdmin,
} from '../../domain/entities/AbasDoAdmin.js';
import { AdministradoresRecusadoError } from '../../domain/errors/index.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type {
  MudancaDePermissao,
  RepositorioDePermissoesDoAdmin,
} from '../../domain/ports/RepositorioDePermissoesDoAdmin.js';

/** Resultado de "quais abas este restrito pode usar?". `ok: false` = não deu para ler: FALHA FECHADA. */
export type AbasDoRestrito =
  { readonly ok: true; readonly abas: readonly AbaDoAdmin[] } | { readonly ok: false };

export interface VisaoDosAdministradores {
  readonly abasDisponiveis: ReadonlyArray<{
    readonly aba: AbaDoAdmin;
    readonly rotulo: string;
  }>;
  /** Declarados em `PROCESSOVIVO_ADMIN_RESTRITOS`: são os únicos que entram e que a tela edita. */
  readonly restritos: ReadonlyArray<{
    readonly usuario: string;
    readonly abas: readonly AbaDoAdmin[];
    readonly ultimoAcesso: Date | null;
  }>;
  /** Têm linha no banco e sumiram da variável: inertes (não entram), só aparecem para o dono saber. */
  readonly semCredencial: ReadonlyArray<{
    readonly usuario: string;
    readonly abas: readonly AbaDoAdmin[];
  }>;
  readonly historico: readonly MudancaDePermissao[];
}

const LIMITE_DO_HISTORICO = 50;
/** O último acesso é gravado no máximo uma vez por minuto por usuário: abrir o /admin não vira escrita a cada clique. */
const INTERVALO_DO_ACESSO_MS = 60_000;

/**
 * Permissões por aba dos administradores restritos (v0.62.0).
 *
 * As CREDENCIAIS não passam por aqui: o dono e os restritos são declarados em variável de ambiente, e este serviço
 * só conhece os NOMES dos restritos declarados (`restritos`). Quem não está nessa lista não entra, tenha ou não
 * linhas no banco. A lista de abas que existem é do código (`ABAS_DO_ADMIN`): linha de aba desconhecida no banco
 * não abre nada, e aba nova nasce fechada.
 */
export class ServicoAdministradores {
  private readonly declarados: ReadonlySet<string>;
  private readonly ultimaGravacaoDoAcesso = new Map<string, number>();

  constructor(
    private readonly o: {
      readonly restritos: readonly string[];
      readonly repositorio: RepositorioDePermissoesDoAdmin;
      readonly clock: Clock;
      readonly logger: Logger;
    },
  ) {
    this.declarados = new Set(o.restritos);
  }

  /** Falha fechada: qualquer erro de leitura devolve `ok: false`, e o restrito não acessa nada. */
  abasDo(usuario: string): AbasDoRestrito {
    if (!this.declarados.has(usuario)) return { ok: true, abas: [] };
    try {
      return { ok: true, abas: abasEmOrdem(this.o.repositorio.abasDe(usuario)) };
    } catch {
      // Sem a mensagem do erro: o banco pode ecoar caminho ou SQL.
      this.o.logger.error(
        'permissões do administrador restrito não puderam ser lidas',
        {},
      );
      return { ok: false };
    }
  }

  visao(): VisaoDosAdministradores {
    const repo = this.o.repositorio;
    const porUsuario = new Map<string, string[]>();
    for (const p of repo.todas()) {
      const lista = porUsuario.get(p.usuario) ?? [];
      lista.push(p.aba);
      porUsuario.set(p.usuario, lista);
    }
    const acessos = repo.ultimosAcessos();
    return {
      abasDisponiveis: ABAS_DO_ADMIN.map((aba) => ({ aba, rotulo: ROTULO_DA_ABA[aba] })),
      restritos: this.o.restritos.map((usuario) => ({
        usuario,
        abas: abasEmOrdem(porUsuario.get(usuario) ?? []),
        ultimoAcesso: acessos.get(usuario) ?? null,
      })),
      semCredencial: [...porUsuario.keys()]
        .filter((u) => !this.declarados.has(u))
        .sort()
        .map((usuario) => ({
          usuario,
          abas: abasEmOrdem(porUsuario.get(usuario) ?? []),
        })),
      historico: repo.historico(LIMITE_DO_HISTORICO),
    };
  }

  /**
   * Deixa o restrito com EXATAMENTE as abas pedidas. Só o dono chega aqui (a rota é "só o dono"); `por` é o autor
   * dele. A mensagem de recusa nunca repete o valor recebido.
   */
  definir(
    por: string,
    usuario: string,
    abas: readonly unknown[],
    confirmado: boolean,
  ): VisaoDosAdministradores {
    if (!this.declarados.has(usuario)) {
      throw new AdministradoresRecusadoError(
        'usuario_desconhecido',
        'Este usuário não está entre os administradores declarados no servidor.',
      );
    }
    const validas: AbaDoAdmin[] = [];
    for (const a of abas) {
      if (!ehAbaDoAdmin(a)) {
        throw new AdministradoresRecusadoError(
          'aba_desconhecida',
          'Alguma das abas pedidas não existe ou não pode ser liberada.',
        );
      }
      validas.push(a);
    }
    if (!confirmado) {
      throw new AdministradoresRecusadoError(
        'confirmacao_necessaria',
        'Confirme a mudança de permissões antes de salvar.',
      );
    }
    const mudancas = this.o.repositorio.substituir(
      usuario,
      abasEmOrdem(validas),
      por,
      this.o.clock.agora(),
    );
    for (const m of mudancas) {
      this.o.logger.info('permissão de administrador alterada', {
        por: m.por,
        usuario: m.usuario,
        aba: m.aba,
        acao: m.acao,
      });
    }
    return this.visao();
  }

  /** Nunca derruba o acesso: falha de gravação só vai ao log. */
  registrarAcesso(usuario: string): void {
    if (!this.declarados.has(usuario)) return;
    const agora = this.o.clock.agora();
    const ultima = this.ultimaGravacaoDoAcesso.get(usuario);
    if (ultima !== undefined && agora.getTime() - ultima < INTERVALO_DO_ACESSO_MS) return;
    try {
      this.o.repositorio.registrarAcesso(usuario, agora);
      this.ultimaGravacaoDoAcesso.set(usuario, agora.getTime());
    } catch {
      this.o.logger.warn('último acesso do administrador não pôde ser gravado', {});
    }
  }
}
