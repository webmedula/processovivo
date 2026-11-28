import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServicoAssinaturas } from '../../../application/services/ServicoAssinaturas.js';
import type { ServicoPecas } from '../../../application/services/ServicoPecas.js';
import {
  OperacaoNaoSuportadaError,
  WorkspaceNaoResolvidoError,
} from '../../../domain/errors/index.js';

function workspaceDe(requisicao: FastifyRequest): string {
  const ws = requisicao.workspace;
  if (!ws) throw new WorkspaceNaoResolvidoError();
  return ws;
}

const corpoCredencial = z.object({
  tribunal: z.string().min(2).max(10),
  /** CPF do consultante, no MNI. Guardado como veio; não é validado como CPF. */
  identificacao: z.string().min(3).max(60),
  senha: z.string().min(1).max(200),
});

/**
 * Rotas das peças e das credenciais de tribunal.
 *
 * Sem serviço montado, tudo aqui responde **501 com instrução** em vez de 404 ou
 * lista vazia. A diferença importa: lista vazia diria ao advogado que o processo
 * dele não tem peças, quando o que falta é configuração do servidor.
 */
export function rotasDePecas(
  servico: ServicoPecas | undefined,
  assinaturas?: ServicoAssinaturas,
): FastifyPluginAsync {
  return async (servidor) => {
    /**
     * Plano primeiro, serviço depois.
     *
     * A ordem importa para quem lê a resposta: "seu plano não inclui peças" é
     * acionável pelo assinante, "o servidor não está configurado" é problema
     * nosso. Perguntando ao contrário, um advogado do plano Acompanhamento
     * receberia 501 numa instalação sem MNI e concluiria que o produto está
     * quebrado, quando ele simplesmente não contratou aquilo.
     *
     * Também é aqui, e não no serviço de peças, porque a credencial do
     * tribunal é do assinante: cadastrar credencial sem ter o plano seria
     * guardar a senha do Projudi de alguém que não pode usá-la.
     */
    async function exigirPlano(req: FastifyRequest): Promise<void> {
      await assinaturas?.exigir(workspaceDe(req), 'pecas');
    }

    function exigirServico(): ServicoPecas {
      if (!servico) {
        throw new OperacaoNaoSuportadaError(
          'pecas',
          'listarPecas',
          'o acesso a peças não está configurado — defina PROCESSOVIVO_CREDENCIAL_CHAVE ' +
            'e MNI_ENDPOINT no ambiente',
        );
      }
      return servico;
    }

    servidor.get<{ Params: { numero: string } }>(
      '/v1/processos/:numero/pecas',
      async (req) => {
        await exigirPlano(req);
        const servico = exigirServico();
        const [{ linha, partes: partesDoTribunal }, jaBaixadas] = await Promise.all([
          servico.reguaDoProcesso(workspaceDe(req), req.params.numero),
          servico.idsJaBaixados(workspaceDe(req), req.params.numero),
        ]);
        const pecas = [
          ...linha.pecasSoltas,
          ...linha.eventos.flatMap((e) => e.pecas ?? []),
        ];

        return {
          // As partes como estão nos AUTOS, da mesma resposta do tribunal (v0.73.0). A tela as
          // prefere às do Diário, que só conhecem quem foi intimado. Só nome, polo, tipo de pessoa e
          // advogados — nunca CPF/CNPJ nem endereço. Vazio = o tribunal não trouxe o cabeçalho.
          partes: partesDoTribunal.map((p) => ({
            nome: p.nome,
            polo: p.polo,
            tipoPessoa: p.tipoPessoa,
            advogados: p.advogados.map((a) => ({
              nome: a.nome,
              ...(a.oab ? { oab: a.oab } : {}),
              ...(a.ufOab ? { ufOab: a.ufOab } : {}),
            })),
          })),
          // Quais peças DESTE processo já saíram daqui. A tela marca o botão, e
          // a marca economiza uma consulta ao tribunal de dezenas de segundos
          // para quem não lembra se já puxou a contestação.
          jaBaixadas,
          // A régua é o que a tela desenha: cada evento já com os documentos
          // daquele ato. `pecas` continua aqui porque a rota é pública para
          // integração (n8n) e quebrar o contrato dela não tem justificativa —
          // e porque é o que sobra quando a junção não acontece.
          linhaDoTempo: {
            resumo: linha.resumo,
            eventos: linha.eventos.map((e) => ({
              data: e.data.toISOString(),
              titulo: e.titulo,
              fonte: e.fonte ?? null,
              exigeAcao: e.exigeAcao === true,
              ehRuido: e.ehRuido === true,
              ehDecisao: e.ehDecisao === true,
              motivoDaTriagem: e.motivoDaTriagem ?? null,
              conteudo: e.conteudo ?? null,
              codigoTpu: e.codigoTpu ?? null,
              complementos: e.complementos ?? [],
              url: e.url ?? null,
              teorIndisponivel: e.teorIndisponivel === true,
              pecas: (e.pecas ?? []).map((p) => p.toJSON()),
            })),
            pecasSoltas: linha.pecasSoltas.map((p) => p.toJSON()),
          },
          total: pecas.length,
          // "Quantas têm arquivo", e NÃO "quantas eu consigo abrir".
          //
          // A segunda pergunta não tem resposta na listagem, e medir isso foi o
          // que mostrou: o MNI nunca manda o teor junto da ficha — nem para quem
          // tem procuração. Só a tentativa de baixar responde. A contagem
          // anterior somava `conteudoDisponivel`, dava zero sempre, e a tela
          // anunciava "nenhuma peça liberada" num processo inteiramente
          // acessível.
          comArquivo: pecas.filter((p) => p.mimetype !== undefined).length,
          pecas: pecas.map((p) => p.toJSON()),
        };
      },
    );

    servidor.get<{ Params: { numero: string; id: string } }>(
      '/v1/processos/:numero/pecas/:id',
      async (req, resposta) => {
        await exigirPlano(req);
        const conteudo = await exigirServico().baixarPeca(
          workspaceDe(req),
          req.params.numero,
          req.params.id,
        );

        void resposta.header('content-type', conteudo.mimetype);
        // `attachment` e não `inline`: são autos de processo, e abrir PDF de
        // terceiro dentro da nossa origem no navegador é superfície que não
        // precisamos ter.
        void resposta.header(
          'content-disposition',
          `attachment; filename="${conteudo.nomeArquivo}"`,
        );
        return resposta.send(Buffer.from(conteudo.bytes));
      },
    );

    /*
     * O histórico de downloads. Metadado apenas — o arquivo nunca ficou aqui.
     *
     * Não exige plano: é o registro do que a própria pessoa já puxou, e
     * trancá-lo atrás de assinatura seria cobrar para ver o próprio histórico.
     */
    servidor.get<{ Querystring: { numero?: string; limite?: string } }>(
      '/v1/pecas-baixadas',
      async (req) => {
        const ws = workspaceDe(req);
        const servico = exigirServico();
        const limite = Number(req.query.limite ?? '10');
        const inicioDoDia = new Date();
        inicioDoDia.setHours(0, 0, 0, 0);

        const [lista, hoje] = await Promise.all([
          servico.historicoDeBaixas(ws, {
            ...(req.query.numero ? { numeroProcesso: req.query.numero } : {}),
            ...(Number.isFinite(limite) ? { limite } : {}),
          }),
          servico.baixadasDesde(ws, inicioDoDia),
        ]);

        return {
          hoje,
          total: lista.length,
          pecas: lista.map((p) => ({
            numero: p.numeroProcesso,
            idPeca: p.idPeca,
            rotulo: p.rotulo,
            mimetype: p.mimetype ?? null,
            bytes: p.bytes,
            baixadaEm: p.baixadaEm.toISOString(),
          })),
        };
      },
    );

    servidor.get('/v1/credenciais', async (req) => {
      await exigirPlano(req);
      const lista = await exigirServico().listarCredenciais(workspaceDe(req));
      return {
        total: lista.length,
        credenciais: lista.map((c) => ({
          tribunal: c.tribunal,
          identificacao: c.identificacao,
          criadaEm: c.criadaEm.toISOString(),
          usadaEm: c.usadaEm?.toISOString() ?? null,
          recusadaEm: c.recusadaEm?.toISOString() ?? null,
        })),
      };
    });

    servidor.put<{ Body: unknown }>('/v1/credenciais', async (req, resposta) => {
      await exigirPlano(req);
      const dados = corpoCredencial.parse(req.body ?? {});
      const cadastrada = await exigirServico().cadastrarCredencial(workspaceDe(req), {
        tribunal: dados.tribunal.toUpperCase(),
        identificacao: dados.identificacao,
        senha: dados.senha,
      });

      void resposta.code(201);
      // A senha não volta. Nem mascarada: devolver `***` convida a interface a
      // exibir um campo "preenchido" que não pode ser reenviado, e o próximo
      // salvamento gravaria os asteriscos como senha.
      return {
        tribunal: cadastrada.tribunal,
        identificacao: cadastrada.identificacao,
        criadaEm: cadastrada.criadaEm.toISOString(),
      };
    });

    // Esta rota NÃO exige plano, e é a única do arquivo que não exige.
    //
    // Quem deixou de ter o plano continua com a senha do Projudi guardada aqui,
    // cifrada, e precisa poder tirá-la. Exigir plano para apagar credencial
    // significaria "pague para poder remover seus dados", que é indefensável —
    // e empurraria a pessoa a pedir exclusão da conta inteira só por isso.
    servidor.delete<{ Params: { tribunal: string } }>(
      '/v1/credenciais/:tribunal',
      async (req, resposta) => {
        const removida = await exigirServico().removerCredencial(
          workspaceDe(req),
          req.params.tribunal,
        );
        if (!removida) {
          void resposta.code(404);
          return {
            erro: 'CREDENCIAL_NAO_CADASTRADA',
            mensagem: 'Não havia credencial cadastrada para este tribunal.',
          };
        }
        return { removida: true };
      },
    );
  };
}
