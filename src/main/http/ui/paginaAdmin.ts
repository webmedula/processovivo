import { ESTILOS } from './estilos.js';
import { FAVICON_DATA_URI, LOGO_FUNDO_ESCURO } from './marca.js';
import { SCRIPT_TEMA } from './pagina.js';
import { ESTILOS_IA_ADMIN, SCRIPT_IA_ADMIN } from './iaAdmin.js';
import { ESTILOS_IA_ADMIN_MODELOS, SCRIPT_IA_ADMIN_MODELOS } from './iaAdminModelos.js';
import {
  ESTILOS_IA_ADMIN_INSTRUCOES,
  SCRIPT_IA_ADMIN_INSTRUCOES,
} from './iaAdminInstrucoes.js';
import { scriptAdminPara } from './scriptAdmin.js';
import { ESTILOS_ADMINISTRADORES, SCRIPT_ADMINISTRADORES } from './administradores.js';
import {
  ROTULO_DA_ABA,
  type AbaDaTela,
  type AbaDoAdmin,
} from '../../../domain/entities/AbasDoAdmin.js';

/**
 * O pouco que só o painel precisa: caixa de marcar (o `input{width:100%}` de
 * `ESTILOS` esticaria a caixinha pela linha inteira) e área de texto.
 */
const ESTILOS_ADMIN = `
.marcas{display:flex;flex-wrap:wrap;gap:8px 18px}
.marcas label{display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer}
.marcas input[type=checkbox]{width:auto;margin:0}
textarea{width:100%;padding:9px 11px;font:inherit;color:var(--tinta);resize:vertical;
  background:var(--papel2);border:1px solid var(--linha);border-radius:8px;outline:0}
textarea:focus{border-color:var(--acento);background:var(--papel)}
.usuario-admin{font-size:11.5px;color:var(--lateral-tinta);padding:0 8px;overflow-wrap:anywhere}
.usuario-admin strong{color:#fff;font-weight:600}
.nav .nav-unica{margin:0;padding:8px 12px;font-size:15px;font-weight:700;color:#fff}
.sem-area{max-width:520px;margin:48px auto;padding:0 16px;text-align:center}
`;

/** Quem entrou e o que a pessoa pode usar — decidido no SERVIDOR; a página só desenha isto. */
export interface ContextoDaPaginaAdmin {
  readonly usuario: string;
  readonly papel: 'dono' | 'restrito';
  /** As abas de uso que o usuário pode abrir, na ordem do menu. */
  readonly abas: readonly AbaDoAdmin[];
  /** A tela de permissões: só o dono. */
  readonly administradores: boolean;
  /** As permissões não puderam ser lidas: o restrito não vê nada além do aviso. */
  readonly semPermissoes?: boolean;
}

const FRASE_SEM_AREA =
  'Nenhuma área liberada para o seu acesso. Fale com o administrador.';
const FRASE_SEM_PERMISSOES =
  'Não foi possível verificar o seu acesso agora. Tente de novo em instantes.';

/**
 * Área administrativa — mesma casca visual do console do assinante
 * (`ui/pagina.ts`), reaproveitando `ESTILOS` para as duas telas não
 * divergirem visualmente à toa.
 *
 * Protegida por HTTP Basic Auth (`plugins/autenticacaoAdmin.ts`), nunca por
 * chave de API nem sessão de assinante — ver o porquê em `adminAuth.ts`. Por
 * isso o `fetch` daqui não manda `x-api-key`: o navegador já guarda a
 * credencial Basic depois do primeiro pedido, para a mesma origem.
 */
export function paginaAdmin(versao: string, contexto: ContextoDaPaginaAdmin): string {
  const visiveis: AbaDaTela[] = [
    ...contexto.abas,
    ...(contexto.administradores ? (['administradores'] as const) : []),
  ];
  const temIa = contexto.abas.includes('ia');
  const semPermissoes = contexto.semPermissoes === true;
  const aviso = semPermissoes ? FRASE_SEM_PERMISSOES : FRASE_SEM_AREA;

  // O restrito só recebe o código (estilos, scripts, menu) das abas liberadas: nada das outras vai na página.
  const estilos =
    ESTILOS +
    ESTILOS_ADMIN +
    (temIa
      ? ESTILOS_IA_ADMIN + ESTILOS_IA_ADMIN_MODELOS + ESTILOS_IA_ADMIN_INSTRUCOES
      : '') +
    (contexto.administradores ? ESTILOS_ADMINISTRADORES : '');
  const scripts =
    visiveis.length === 0
      ? ''
      : (temIa
          ? `<script>${SCRIPT_IA_ADMIN}</script>\n<script>${SCRIPT_IA_ADMIN_MODELOS}</script>\n<script>${SCRIPT_IA_ADMIN_INSTRUCOES}</script>\n`
          : '') +
        (contexto.administradores ? `<script>${SCRIPT_ADMINISTRADORES}</script>\n` : '') +
        `<script>${scriptAdminPara(contexto.abas, contexto.administradores)}</script>`;

  const menu =
    visiveis.length === 0
      ? ''
      : visiveis.length === 1
        ? `<nav class="nav" aria-label="Área"><p class="nav-unica" data-aba="${visiveis[0]}">${ROTULO_DA_ABA[visiveis[0] as AbaDaTela]}</p></nav>`
        : `<nav class="nav" aria-label="Áreas">${visiveis
            .map(
              (a) =>
                `<button type="button" id="nav-${a}" data-aba="${a}">${ROTULO_DA_ABA[a]}</button>`,
            )
            .join('')}</nav>`;
  const papel = contexto.papel === 'dono' ? 'dono' : 'administrador restrito';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Processo Vivo — administração</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
<script>${SCRIPT_TEMA}</script>
<style>${estilos}</style>
</head>
<body>

<div class="app">
  <aside class="lateral" id="lateral">
    <div class="marca">
      ${LOGO_FUNDO_ESCURO}
      <div class="sub">administração</div>
    </div>
    ${menu}
    <div class="lateral-pe">
      <div class="usuario-admin" id="usuario-admin">Entrou como <strong>${escaparHtml(contexto.usuario)}</strong> · ${papel}</div>
      <div class="versao">v${versao}</div>
    </div>
  </aside>

  <main class="env">
    ${temIa ? '<div id="aviso-ia" role="status" hidden></div>' : ''}
    ${
      visiveis.length === 0
        ? `<div class="sem-area" id="sem-area"><p class="vazio" role="status">${aviso}</p></div>`
        : '<div id="conteudo"></div>'
    }
  </main>
</div>

${scripts}
</body>
</html>`;
}

function escaparHtml(texto: string): string {
  return texto.replace(
    /[&<>"']/g,
    (c) =>
      (
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }) as Record<string, string>
      )[c] ?? c,
  );
}
