import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export interface OpcoesAutenticacaoAdmin {
  readonly usuario: string;
  readonly senha: string;
}

/**
 * HTTP Basic Auth para a área administrativa — um operador só, credencial
 * própria em `PROCESSOVIVO_ADMIN_USUARIO`/`PROCESSOVIVO_ADMIN_SENHA`.
 *
 * **Por que Basic Auth, e não sessão de cookie igual ao console do
 * assinante:** o `CLAUDE.md` já registra por que este sistema nunca inventou
 * "administrador" como campo na tabela `usuarios` — faria de um cadastro
 * aberto uma escalada de privilégio. Reaproveitar `ServicoContas` e a sessão
 * do assinante para o operador puxaria exatamente essa mistura para dentro do
 * código, ainda que sem o campo booleano. Basic Auth resolve com uma
 * credencial fixa, um hook, e zero linha tocando `usuarios` ou `sessoes` — o
 * navegador pede a senha uma vez e guarda para as chamadas seguintes da mesma
 * origem, então a página e as rotas `/admin/api/*` funcionam sem tela de
 * login própria nem cookie para gerenciar.
 *
 * **Por que isto é uma função comum, e não um plugin registrado com
 * `fastify.register()`:** `register()` sempre cria um contexto de
 * encapsulamento FILHO — mesmo sem `fastify-plugin` — e um hook adicionado lá
 * dentro vale só para rotas registradas DENTRO daquele mesmo filho, nunca
 * para rotas irmãs registradas direto na instância pai. `rotasDeAdmin` chama
 * esta função passando a SUA PRÓPRIA instância (`app.addHook` aqui é o mesmo
 * `addHook` que as rotas administrativas usam, na mesma instância), o que é o
 * que de fato faz o hook valer para aquelas rotas — e só para elas, porque
 * `rotasDeAdmin` em si já é a instância filha que `servidor.register()` criou
 * em `servidor.ts`, isolada do resto do servidor.
 */
export function autenticacaoAdmin(app: FastifyInstance, opcoes: OpcoesAutenticacaoAdmin): void {
  app.addHook('onRequest', async (requisicao, resposta) => {
    const credencial = lerBasic(requisicao.headers.authorization);

    if (
      credencial &&
      comparaSegura(credencial.usuario, opcoes.usuario) &&
      comparaSegura(credencial.senha, opcoes.senha)
    ) {
      return;
    }

    requisicao.log.warn({ ip: requisicao.ip }, 'acesso administrativo rejeitado');
    // Valor do cabeçalho tem de ser ASCII puro — Node recusa com
    // ERR_INVALID_CHAR qualquer caractere fora de Latin-1/ASCII aqui (nada de
    // travessão ou acento, por mais que "administração" fique menos bonito).
    void resposta.header(
      'www-authenticate',
      'Basic realm="Processo Vivo - area administrativa", charset="UTF-8"',
    );
    return resposta.code(401).send({
      erro: 'NAO_AUTENTICADO',
      mensagem: 'Credencial administrativa ausente ou inválida.',
    });
  });
}

function lerBasic(cabecalho: string | undefined): { usuario: string; senha: string } | undefined {
  if (!cabecalho || !cabecalho.startsWith('Basic ')) return undefined;

  let decodificado: string;
  try {
    decodificado = Buffer.from(cabecalho.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    return undefined;
  }

  const indice = decodificado.indexOf(':');
  if (indice === -1) return undefined;
  return { usuario: decodificado.slice(0, indice), senha: decodificado.slice(indice + 1) };
}

/**
 * Comparação em tempo constante — mesma função de `plugins/autenticacao.ts`,
 * duplicada aqui de propósito em vez de importada: os dois arquivos protegem
 * segredos DIFERENTES (chave de assinante vs. senha do operador), e mantê-los
 * sem dependência um do outro é o que garante que mexer num nunca muda o
 * comportamento do outro por acidente.
 */
function comparaSegura(informada: string, esperada: string): boolean {
  const a = Buffer.from(informada);
  const b = Buffer.from(esperada);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
