import { describe, expect, it } from 'vitest';
import {
  MAXIMO_DE_TENTATIVAS,
  NOME_DA_PASTA_RAIZ,
  TETO_DA_ESPERA_MS,
} from '../../src/application/services/ServicoDrive.js';
import {
  AutorizacaoDoDestinoRevogadaError,
  CredencialTribunalAusenteError,
  DestinoIndisponivelError,
  DestinoLimitouError,
  DestinoRecusouError,
  DestinoSemEspacoError,
  DriveRecusadoError,
  MniBloqueadoError,
  PastaRemovidaNoDestinoError,
  PecaDaPastaNaoEncontradaError,
  SegredoDeJusticaNaoGuardadoError,
} from '../../src/domain/errors/index.js';
import { NUMERO, NUMERO_FORMATADO, montarCenario, peca } from '../helpers/drive.js';
import type { CenarioDrive } from '../helpers/drive.js';
import {
  CODIGO_DO_GOOGLE,
  TOKEN_DE_ACESSO,
  TOKEN_DE_RENOVACAO,
} from '../helpers/transporteDoDrive.js';

// Tudo sintético (o repositório é público): peças, números e tokens são inventados.
const WS = 'ws-a';

async function enviar(
  c: CenarioDrive,
  pecas: readonly string[] | 'todas' = 'todas',
  extra: { reenviarRemovidas?: boolean; workspace?: string } = {},
) {
  const e = await c.servico.iniciarEnvio({
    workspace: extra.workspace ?? WS,
    numeroProcesso: NUMERO,
    pecas,
    ...(extra.reenviarRemovidas ? { reenviarRemovidas: true } : {}),
  });
  await c.servico.aguardarOcioso();
  return c.servico.envio(extra.workspace ?? WS, e.id);
}

async function recusa(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('devia ter sido recusado');
}

const motivoDe = (e: unknown): string | undefined =>
  e instanceof DriveRecusadoError ? e.motivo : undefined;

describe('ServicoDrive — conexão', () => {
  it('sem plano: a visão diz só "sem plano" e NENHUMA chamada vai ao Google', async () => {
    const c = montarCenario([peca(1)]);
    c.plano = false;
    const v = await c.servico.visao(WS);
    expect(v.plano).toBe(false);
    expect(v.estado).toBe('desconectado');
    expect(c.destino.chamadas).toEqual([]);
  });

  it('sem plano: iniciar a conexão é recusado (403), sem chamar o Google', async () => {
    const c = montarCenario([peca(1)]);
    c.plano = false;
    const e = await recusa(c.servico.iniciarConexao(WS));
    expect(motivoDe(e)).toBe('sem_plano');
    expect(c.destino.chamadas).toEqual([]);
  });

  it('conecta: cria a pasta raiz "Processo Vivo" e guarda o link para o botão "Abrir no Drive"', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    const v = await c.servico.visao(WS);
    expect(v.estado).toBe('conectado');
    expect(v.linkDaPastaRaiz).toMatch(/^https:\/\/drive\.google\.com\//);
    const criacao = c.destino.chamadas.find((x) => x.op === 'garantirPasta');
    expect(criacao?.detalhe?.['nome']).toBe(NOME_DA_PASTA_RAIZ);
    expect(criacao?.detalhe?.['idConhecido']).toBeUndefined();
  });

  it('state de outro workspace, reutilizado, expirado ou inventado: recusado e o Google NÃO é chamado', async () => {
    const c = montarCenario([peca(1)]);
    const { url } = await c.servico.iniciarConexao(WS);
    const estado = new URL(url).searchParams.get('state') as string;

    // De outra conta.
    expect(
      await c.servico.concluirConexao({ workspace: 'ws-b', codigo: 'x', estado }),
    ).toEqual({
      ok: false,
      motivo: 'estado_invalido',
    });
    // Inventado.
    expect(
      await c.servico.concluirConexao({ workspace: WS, codigo: 'x', estado: 'a.b' }),
    ).toEqual({
      ok: false,
      motivo: 'estado_invalido',
    });
    expect(c.destino.contar('concluirConexao')).toBe(0);

    // O legítimo ainda vale (a recusa de outra conta não o gastou) — e só uma vez.
    expect(
      (
        await c.servico.concluirConexao({
          workspace: WS,
          codigo: CODIGO_DO_GOOGLE,
          estado,
        })
      ).ok,
    ).toBe(true);
    expect(
      await c.servico.concluirConexao({ workspace: WS, codigo: 'x', estado }),
    ).toEqual({
      ok: false,
      motivo: 'estado_invalido',
    });
    expect(c.destino.contar('concluirConexao')).toBe(1);

    // Expirado.
    const novo = new URL((await c.servico.iniciarConexao(WS)).url).searchParams.get(
      'state',
    ) as string;
    c.relogio.avancar(11 * 60_000);
    expect(
      await c.servico.concluirConexao({ workspace: WS, codigo: 'x', estado: novo }),
    ).toEqual({
      ok: false,
      motivo: 'estado_invalido',
    });
    expect(c.destino.contar('concluirConexao')).toBe(1);
  });

  it('permissão da pasta desmarcada no Google: nada é conectado', async () => {
    const c = montarCenario([peca(1)]);
    c.destino.escopoConcedido = false;
    const { url } = await c.servico.iniciarConexao(WS);
    const estado = new URL(url).searchParams.get('state') as string;
    expect(
      await c.servico.concluirConexao({ workspace: WS, codigo: 'x', estado }),
    ).toEqual({
      ok: false,
      motivo: 'escopo_negado',
    });
    expect((await c.servico.visao(WS)).estado).toBe('desconectado');
    expect(await c.repo.autorizacao(WS)).toBeUndefined();
  });

  it('o advogado recusou na tela do Google: o state é gasto sem chamar o Google', async () => {
    const c = montarCenario([peca(1)]);
    const { url } = await c.servico.iniciarConexao(WS);
    const estado = new URL(url).searchParams.get('state') as string;
    c.servico.descartarConexao(WS, estado);
    expect(
      await c.servico.concluirConexao({ workspace: WS, codigo: 'x', estado }),
    ).toEqual({
      ok: false,
      motivo: 'estado_invalido',
    });
    expect(c.destino.contar('concluirConexao')).toBe(0);
  });

  it('perdeu o plano entre o clique e o retorno: não conecta', async () => {
    const c = montarCenario([peca(1)]);
    const { url } = await c.servico.iniciarConexao(WS);
    const estado = new URL(url).searchParams.get('state') as string;
    c.plano = false;
    expect(
      await c.servico.concluirConexao({ workspace: WS, codigo: 'x', estado }),
    ).toEqual({
      ok: false,
      motivo: 'sem_plano',
    });
    expect(c.destino.contar('concluirConexao')).toBe(0);
  });

  it('reconectar reaproveita a pasta raiz que já existe (não deixa outra "Processo Vivo" ao lado)', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    const raiz = (await c.repo.conexao(WS))?.pastaRaiz?.id as string;
    await c.servico.desconectar(WS);
    await c.conectar();
    const chamadas = c.destino.chamadas.filter((x) => x.op === 'garantirPasta');
    expect(chamadas[1]?.detalhe?.['idConhecido']).toBe(raiz);
    expect((await c.repo.conexao(WS))?.pastaRaiz?.id).toBe(raiz);
  });

  it('desconectar revoga no Google, APAGA os tokens do cofre e não toca em nada do Drive do advogado', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    await enviar(c);
    const arquivosAntes = c.destino.envios.length;
    await c.servico.desconectar(WS);
    expect(c.destino.contar('desconectar')).toBe(1);
    expect(await c.repo.autorizacao(WS)).toBeUndefined();
    expect((await c.servico.visao(WS)).estado).toBe('desconectado');
    expect(c.destino.envios.length).toBe(arquivosAntes);
    expect(c.destino.envios.every((a) => !a.trashed)).toBe(true);
    // O histórico fica, marcado como desconectado.
    expect((await c.repo.peca(WS, NUMERO, 'p1'))?.estado).toBe('desconectada');
  });

  it('desconectar vale mesmo com a assinatura vencida: sair é direito de quem está dentro', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    c.plano = false;
    await c.servico.desconectar(WS);
    expect(await c.repo.autorizacao(WS)).toBeUndefined();
  });

  it('o desconectar durante um envio o cancela, e o envio não desfaz o desconectar', async () => {
    const c = montarCenario([peca(1), peca(2), peca(3)]);
    await c.conectar();
    const e = await c.servico.iniciarEnvio({
      workspace: WS,
      numeroProcesso: NUMERO,
      pecas: 'todas',
    });
    await c.servico.desconectar(WS);
    await c.servico.aguardarOcioso();
    expect((await c.servico.visao(WS)).estado).toBe('desconectado');
    expect((await c.servico.envio(WS, e.id)).estado).not.toBe('em_andamento');
  });
});

describe('ServicoDrive — o que NÃO vai ao Google', () => {
  it('sem plano: o envio é recusado e o Google não é chamado', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    const antes = c.destino.chamadas.length;
    c.plano = false;
    const e = await recusa(
      c.servico.iniciarEnvio({ workspace: WS, numeroProcesso: NUMERO, pecas: 'todas' }),
    );
    expect(motivoDe(e)).toBe('sem_plano');
    expect(c.destino.chamadas.length).toBe(antes);
  });

  it('sem conexão e com a autorização caída: recusa com o motivo certo, sem chamar o Google', async () => {
    const c = montarCenario([peca(1)]);
    expect(
      motivoDe(
        await recusa(
          c.servico.iniciarEnvio({
            workspace: WS,
            numeroProcesso: NUMERO,
            pecas: 'todas',
          }),
        ),
      ),
    ).toBe('nao_conectado');
    await c.conectar();
    await c.repo.marcarEstado(
      WS,
      'precisa_reconectar',
      'autorizacao_revogada',
      c.relogio.agora(),
    );
    const antes = c.destino.chamadas.length;
    expect(
      motivoDe(
        await recusa(
          c.servico.iniciarEnvio({
            workspace: WS,
            numeroProcesso: NUMERO,
            pecas: 'todas',
          }),
        ),
      ),
    ).toBe('precisa_reconectar');
    expect(c.destino.chamadas.length).toBe(antes);
  });

  it('processo em segredo de justiça: ZERO chamadas ao Drive, mesmo pedindo todas', async () => {
    const c = montarCenario([peca(1), peca(2)]);
    await c.conectar();
    const antes = c.destino.chamadas.length;
    c.fonte.processoSigiloso = true;
    const e = await recusa(
      c.servico.iniciarEnvio({ workspace: WS, numeroProcesso: NUMERO, pecas: 'todas' }),
    );
    expect(e).toBeInstanceOf(SegredoDeJusticaNaoGuardadoError);
    expect(c.destino.chamadas.length).toBe(antes);
    expect(c.fonte.pedidas).toEqual([]);
  });

  it('peça sigilosa não vai ao Drive, nem pedindo; o resultado diz quantas ficaram de fora', async () => {
    const c = montarCenario([
      peca(1),
      peca(2, { sigilosa: true }),
      peca(3, { sigilosa: true }),
    ]);
    await c.conectar();
    const r = await enviar(c, 'todas');
    expect(r.sigilosasForaDoEnvio).toBe(2);
    expect(r.progresso.enviadas).toBe(1);
    expect(c.destino.envios.map((a) => a.nome)).toEqual([
      '0001 - Petição 1 - 11-09-2026.pdf',
    ]);

    // Pedindo a sigilosa pelo id: também fica de fora.
    const r2 = await enviar(c, ['p1', 'p2']);
    expect(r2.sigilosasForaDoEnvio).toBe(1);
    expect(r2.total).toBe(1);
    expect(c.destino.envios).toHaveLength(1);
  });

  it('só peças sigilosas: nada a enviar, sem criar pasta nenhuma', async () => {
    const c = montarCenario([peca(1, { sigilosa: true })]);
    await c.conectar();
    const antes = c.destino.chamadas.length;
    const e = await recusa(
      c.servico.iniciarEnvio({ workspace: WS, numeroProcesso: NUMERO, pecas: ['p1'] }),
    );
    expect(motivoDe(e)).toBe('nada_para_enviar');
    expect(c.destino.chamadas.length).toBe(antes);
  });

  it('id de peça que não está na pasta deste workspace: recusado (nada vindo do cliente é aceito)', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    const e = await recusa(
      c.servico.iniciarEnvio({
        workspace: WS,
        numeroProcesso: NUMERO,
        pecas: ['inventada'],
      }),
    );
    expect(e).toBeInstanceOf(PecaDaPastaNaoEncontradaError);
  });

  it('o destino só recebe as operações permitidas: nada de apagar, renomear, listar ou compartilhar', async () => {
    const c = montarCenario([peca(1), peca(2)]);
    await c.conectar();
    await enviar(c);
    const ops = new Set(c.destino.chamadas.map((x) => x.op));
    for (const op of ops) {
      expect([
        'iniciarConexao',
        'concluirConexao',
        'renovar',
        'garantirPasta',
        'conferirArquivo',
        'enviarArquivo',
      ]).toContain(op);
    }
  });
});

describe('ServicoDrive — o envio', () => {
  it('cria a subpasta com o número do processo e envia cada peça com o nome da convenção', async () => {
    const c = montarCenario([
      peca(1, { rotulo: 'Petição - inicial' }),
      peca(2, { rotulo: 'Decisão' }),
    ]);
    await c.conectar();
    const r = await enviar(c);
    expect(r.estado).toBe('concluido');
    expect(r.progresso).toMatchObject({ enviadas: 2, jaEstavam: 0, falhas: 0 });
    expect(r.linkDaPasta).toMatch(/^https:\/\/drive\.google\.com\//);

    const sub = [...c.destino.pastas.values()].find((p) => p.nome === NUMERO_FORMATADO);
    expect(sub).toBeDefined();
    const raiz = [...c.destino.pastas.values()].find(
      (p) => p.nome === NOME_DA_PASTA_RAIZ,
    );
    expect(sub?.paiId).toBe(raiz?.id);
    expect(c.destino.envios.map((a) => a.nome)).toEqual([
      '0001 - Petição - inicial - 11-09-2026.pdf',
      '0002 - Decisão - 12-09-2026.pdf',
    ]);
    expect(c.destino.envios.every((a) => a.paiId === sub?.id)).toBe(true);
  });

  it('manda uma peça por vez, na ordem dos autos, com pausa entre elas', async () => {
    const c = montarCenario([peca(3), peca(1), peca(2)], { pausaEntrePecasMs: 400 });
    await c.conectar();
    await enviar(c);
    expect(c.destino.envios.map((a) => a.nome.slice(0, 4))).toEqual([
      '0001',
      '0002',
      '0003',
    ]);
    expect(c.esperas.filter((ms) => ms === 400)).toHaveLength(2);
  });

  it('registra o controle: arquivo, hash e nome por (workspace, processo, peça)', async () => {
    const c = montarCenario([peca(1, { conteudo: 'conteúdo-1' })]);
    await c.conectar();
    await enviar(c);
    const reg = await c.repo.peca(WS, NUMERO, 'p1');
    expect(reg?.estado).toBe('no_destino');
    expect(reg?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(reg?.arquivoId).toBe(c.destino.envios[0]?.id);
    expect(reg?.nome).toBe(c.destino.envios[0]?.nome);
  });

  it('IDEMPOTÊNCIA: reenviar a mesma peça não duplica arquivo — "já estavam"', async () => {
    const c = montarCenario([peca(1), peca(2)]);
    await c.conectar();
    await enviar(c);
    const antes = c.destino.contar('enviarArquivo');
    const r = await enviar(c);
    expect(r.progresso).toMatchObject({ enviadas: 0, jaEstavam: 2, atualizadas: 0 });
    expect(c.destino.contar('enviarArquivo')).toBe(antes);
    expect(c.destino.envios).toHaveLength(2);
  });

  it('conteúdo novo (hash mudou) ATUALIZA o mesmo arquivo, sem criar outro', async () => {
    const c = montarCenario([peca(1, { conteudo: 'versão A' })]);
    await c.conectar();
    await enviar(c);
    const id = c.destino.envios[0]?.id;
    c.fonte.guarda.set('p1', {
      bytes: new TextEncoder().encode('versão B'),
      conversao: 'nenhuma',
    });
    const r = await enviar(c);
    expect(r.progresso).toMatchObject({ atualizadas: 1, enviadas: 0 });
    expect(c.destino.envios).toHaveLength(1);
    expect(c.destino.envios[0]?.id).toBe(id);
    const enviosComId = c.destino.chamadas.filter(
      (x) => x.op === 'enviarArquivo' && x.detalhe?.['arquivoId'],
    );
    expect(enviosComId).toHaveLength(1);
  });

  it('arquivo apagado pelo advogado no Drive: NÃO reenvia sozinho — conta como "removida no Drive"', async () => {
    const c = montarCenario([peca(1), peca(2)]);
    await c.conectar();
    await enviar(c);
    c.destino.apagarArquivo(c.destino.envios[0]?.id as string);
    const antes = c.destino.contar('enviarArquivo');

    const r = await enviar(c);
    expect(r.progresso).toMatchObject({ removidasNoDrive: 1, jaEstavam: 1, enviadas: 0 });
    expect(r.removidasNoDrive).toEqual(['p1']);
    expect(c.destino.contar('enviarArquivo')).toBe(antes);
    expect((await c.repo.peca(WS, NUMERO, 'p1'))?.estado).toBe('removida_no_destino');

    // De novo, sem o clique de reenviar: continua sem reenviar.
    const r2 = await enviar(c);
    expect(r2.progresso.removidasNoDrive).toBe(1);
    expect(c.destino.contar('enviarArquivo')).toBe(antes);
  });

  it('arquivo apagado: reenviar só por clique, e o reenvio cria um arquivo NOVO', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    await enviar(c);
    const antigo = c.destino.envios[0]?.id as string;
    c.destino.apagarArquivo(antigo);
    await enviar(c);
    const r = await enviar(c, ['p1'], { reenviarRemovidas: true });
    expect(r.progresso.enviadas).toBe(1);
    expect(r.removidasNoDrive).toEqual([]);
    const novo = await c.repo.peca(WS, NUMERO, 'p1');
    expect(novo?.estado).toBe('no_destino');
    expect(novo?.arquivoId).not.toBe(antigo);
  });

  it('arquivo restaurado da lixeira volta a valer como enviado', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    await enviar(c);
    const id = c.destino.envios[0]?.id as string;
    c.destino.apagarArquivo(id);
    await enviar(c);
    c.destino.restaurarArquivo(id);
    const r = await enviar(c);
    expect(r.progresso.jaEstavam).toBe(1);
    expect((await c.repo.peca(WS, NUMERO, 'p1'))?.estado).toBe('no_destino');
  });

  it('peça convertida: o nome leva o marcador e a descrição leva a observação da Pasta', async () => {
    const c = montarCenario([
      peca(1, {
        rotulo: 'Decisão',
        conversao: 'html',
        observacao: 'Imagens não entram na conversão.',
      }),
    ]);
    await c.conectar();
    await enviar(c);
    expect(c.destino.envios[0]?.nome).toBe(
      '0001 - Decisão - 11-09-2026 (conversão de HTML).pdf',
    );
    expect(c.destino.envios[0]?.descricao).toContain('Imagens não entram na conversão.');
  });

  it('peças de nome igual ganham (2), calculado sobre o processo inteiro e não sobre a seleção', async () => {
    const mesma = {
      rotulo: 'Outros',
      numeroDoAto: 5,
      data: new Date('2026-09-20T15:00:00.000Z'),
    };
    const c = montarCenario([peca(1, mesma), peca(2, mesma), peca(3, mesma)]);
    await c.conectar();
    await enviar(c, ['p3']);
    expect(c.destino.envios[0]?.nome).toBe('0005 - Outros - 20-09-2026 (3).pdf');
  });

  it('um envio por workspace, e o teto global é baixo', async () => {
    const c = montarCenario([peca(1), peca(2)], { maxSimultaneos: 1 });
    await c.conectar();
    await c.conectar('ws-b');
    const primeiro = await c.servico.iniciarEnvio({
      workspace: WS,
      numeroProcesso: NUMERO,
      pecas: 'todas',
    });
    // Dois cliques seguidos, sem esperar: o segundo é recusado.
    expect(
      motivoDe(
        await recusa(
          c.servico.iniciarEnvio({
            workspace: WS,
            numeroProcesso: NUMERO,
            pecas: 'todas',
          }),
        ),
      ),
    ).toBe('job_em_andamento');
    // Outro workspace esbarra no teto global (1).
    expect(
      motivoDe(
        await recusa(
          c.servico.iniciarEnvio({
            workspace: 'ws-b',
            numeroProcesso: NUMERO,
            pecas: 'todas',
          }),
        ),
      ),
    ).toBe('limite_global');
    await c.servico.aguardarOcioso();
    expect((await c.servico.envio(WS, primeiro.id)).estado).toBe('concluido');
    // Terminado, libera.
    await expect(
      c.servico.iniciarEnvio({
        workspace: 'ws-b',
        numeroProcesso: NUMERO,
        pecas: 'todas',
      }),
    ).resolves.toBeDefined();
    await c.servico.aguardarOcioso();
  });

  it('isolamento: o envio de A não existe para B — a MESMA resposta de "não existe"', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    const e = await c.servico.iniciarEnvio({
      workspace: WS,
      numeroProcesso: NUMERO,
      pecas: 'todas',
    });
    await c.servico.aguardarOcioso();
    const deOutro = await recusa(c.servico.envio('ws-b', e.id));
    const inexistente = await recusa(c.servico.envio('ws-b', 'nao-existe'));
    expect(motivoDe(deOutro)).toBe('job_nao_encontrado');
    expect(deOutro).toMatchObject({ message: (inexistente as Error).message });
    expect(motivoDe(await recusa(c.servico.cancelar('ws-b', e.id)))).toBe(
      'job_nao_encontrado',
    );
  });

  it('cancelar enquanto espera a peça chegar do tribunal: termina como cancelado, sem contar falha', async () => {
    const c = montarCenario([peca(1), peca(2)]);
    c.fonte.guarda.clear();
    c.fonte.estadoDasQueNaoChegam = 'na_fila';
    await c.conectar();
    const e = await c.servico.iniciarEnvio({
      workspace: WS,
      numeroProcesso: NUMERO,
      pecas: 'todas',
    });
    c.aoEsperar = () => void c.servico.cancelar(WS, e.id);
    await c.servico.aguardarOcioso();
    const r = await c.servico.envio(WS, e.id);
    expect(r.estado).toBe('cancelado');
    expect(r.progresso.falhas).toBe(0);
    expect(c.fonte.pedidas).toEqual(['p1']);
  });

  it('cancelar interrompe o envio: o que foi enviado fica, o resto não vai', async () => {
    const c = montarCenario([peca(1), peca(2), peca(3), peca(4)]);
    await c.conectar();
    const e = await c.servico.iniciarEnvio({
      workspace: WS,
      numeroProcesso: NUMERO,
      pecas: 'todas',
    });
    await c.servico.cancelar(WS, e.id);
    await c.servico.aguardarOcioso();
    const r = await c.servico.envio(WS, e.id);
    expect(r.estado).toBe('cancelado');
    expect(c.destino.envios.length).toBeLessThan(4);
    // E libera o workspace para um novo envio.
    await expect(
      c.servico.iniciarEnvio({ workspace: WS, numeroProcesso: NUMERO, pecas: 'todas' }),
    ).resolves.toBeDefined();
    await c.servico.aguardarOcioso();
  });
});

describe('ServicoDrive — a peça que venceu da guarda', () => {
  it('peça já enviada que saiu da guarda NÃO volta ao tribunal: só se confere se o arquivo existe', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    await enviar(c);
    c.fonte.guarda.delete('p1'); // venceu das 24 h
    const r = await enviar(c);
    expect(r.progresso.jaEstavam).toBe(1);
    expect(c.fonte.pedidas).toEqual([]);
    expect(c.destino.contar('enviarArquivo')).toBe(1);
  });

  it('peça nunca enviada e fora da guarda: é pedida pelo caminho da Pasta (solicitar) e depois enviada', async () => {
    const c = montarCenario([peca(1, { conteudo: 'x' })]);
    c.fonte.guarda.clear();
    c.fonte.noTribunal.set('p1', new TextEncoder().encode('%PDF peça do tribunal'));
    await c.conectar();
    const r = await enviar(c);
    expect(c.fonte.pedidas).toEqual(['p1']);
    expect(r.progresso.enviadas).toBe(1);
  });

  it('falha ao baixar a peça do tribunal: a peça falha, o lote continua e o motivo é dito', async () => {
    const c = montarCenario([peca(1), peca(2)]);
    c.fonte.guarda.delete('p1');
    c.fonte.estadoDasQueNaoChegam = 'nao_obtida';
    await c.conectar();
    const r = await enviar(c);
    expect(r.estado).toBe('concluido');
    expect(r.progresso).toMatchObject({ falhas: 1, enviadas: 1 });
    expect(r.falhasDasPecas).toEqual([{ pecaId: 'p1', motivo: 'tribunal_nao_entregou' }]);
  });

  it('credencial do tribunal ausente: o lote PARA, sem insistir', async () => {
    const c = montarCenario([peca(1), peca(2)]);
    c.fonte.guarda.clear();
    c.fonte.erroAoSolicitar = new CredencialTribunalAusenteError('TJGO');
    await c.conectar();
    const r = await enviar(c);
    expect(r.estado).toBe('interrompido');
    expect(r.motivoDaParada).toBe('credencial_do_tribunal');
    expect(c.fonte.pedidas).toEqual(['p1']);
  });

  it('tribunal bloqueado: o lote para e diz quando volta', async () => {
    const volta = new Date('2026-10-14T14:00:00.000Z');
    const c = montarCenario([peca(1), peca(2)]);
    c.fonte.guarda.clear();
    c.fonte.erroAoSolicitar = new MniBloqueadoError('mni', volta);
    await c.conectar();
    const r = await enviar(c);
    expect(r.motivoDaParada).toBe('bloqueio_do_tribunal');
    expect(r.retomarEm).toEqual(volta);
  });

  it('pedido trocado pela Pasta (o advogado clicou noutra peça): pede de novo, um número limitado de vezes', async () => {
    const c = montarCenario([peca(1)]);
    c.fonte.guarda.clear();
    c.fonte.estadoDasQueNaoChegam = 'nao_baixada';
    await c.conectar();
    const r = await enviar(c);
    expect(c.fonte.pedidas.length).toBeLessThanOrEqual(3);
    expect(r.falhasDasPecas[0]?.motivo).toBe('tempo_esgotado');
  });
});

describe('ServicoDrive — autorização', () => {
  it('invalid_grant na renovação: o envio para, a conexão vira "precisa reconectar" e NADA é enviado', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    c.relogio.avancar(2 * 3_600_000); // o token venceu
    c.destino.falhaNaRenovacao = new AutorizacaoDoDestinoRevogadaError('revogada', 'x');
    const r = await enviar(c);
    expect(r.estado).toBe('interrompido');
    expect(r.motivoDaParada).toBe('precisa_reconectar');
    expect(c.destino.contar('enviarArquivo')).toBe(0);
    const v = await c.servico.visao(WS);
    expect(v.estado).toBe('precisa_reconectar');
    expect(v.motivoDoUltimoErro).toBe('autorizacao_revogada');
  });

  it('o token vencido é renovado ANTES de usar, e o novo fica no cofre', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    c.relogio.avancar(2 * 3_600_000);
    await enviar(c);
    expect(c.destino.contar('renovar')).toBe(1);
    const a = await c.repo.autorizacao(WS);
    expect(a?.tokenDeAcesso).toContain('RENOVADO');
    expect(a?.tokenDeRenovacao).toBe(TOKEN_DE_RENOVACAO);
    // Os envios usaram o token novo.
    const enviado = c.destino.chamadas.find((x) => x.op === 'enviarArquivo');
    expect(enviado?.detalhe?.['token']).toContain('RENOVADO');
  });

  it('um 401 no meio renova UMA vez e repete — não é revogação', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    c.destino.vencerAutorizacaoAntes = 1;
    const r = await enviar(c);
    expect(r.progresso.enviadas).toBe(1);
    expect(c.destino.contar('renovar')).toBe(1);
    expect((await c.servico.visao(WS)).estado).toBe('conectado');
  });

  it('a renovação tem TRAVA: duas chamadas ao mesmo tempo renovam UMA vez só', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    c.relogio.avancar(2 * 3_600_000);
    let liberar!: () => void;
    c.destino.atrasoDaRenovacao = new Promise<void>((r) => (liberar = r));
    // O envio é de um job por workspace, então a trava é defensiva: chamamos o ponto único de
    // autorização duas vezes ao mesmo tempo, que é exatamente o que ela existe para segurar.
    const interno = c.servico as unknown as {
      autorizacao(workspace: string, forcar: boolean): Promise<{ tokenDeAcesso: string }>;
    };
    const a = interno.autorizacao(WS, false);
    const b = interno.autorizacao(WS, false);
    liberar();
    const [ra, rb] = await Promise.all([a, b]);
    expect(c.destino.contar('renovar')).toBe(1);
    expect(ra.tokenDeAcesso).toBe(rb.tokenDeAcesso);
  });

  it('tokens e segredos NUNCA aparecem no log', async () => {
    const c = montarCenario([peca(1), peca(2)]);
    await c.conectar();
    c.relogio.avancar(2 * 3_600_000);
    c.destino.falhasDeEnvio = [new DestinoIndisponivelError(503), undefined];
    await enviar(c);
    await c.servico.desconectar(WS);
    const tudo = c.logger.linhas.join('\n');
    expect(tudo.length).toBeGreaterThan(0);
    for (const segredo of [
      TOKEN_DE_ACESSO,
      TOKEN_DE_RENOVACAO,
      CODIGO_DO_GOOGLE,
      'RENOVADO',
    ]) {
      expect(tudo).not.toContain(segredo);
    }
  });
});

describe('ServicoDrive — falhas do Drive', () => {
  it('Drive cheio: o lote PARA e orienta o advogado; as peças restantes nem são tentadas', async () => {
    const c = montarCenario([peca(1), peca(2), peca(3)]);
    await c.conectar();
    c.destino.falhasDeEnvio = [undefined, new DestinoSemEspacoError()];
    const r = await enviar(c);
    expect(r.estado).toBe('interrompido');
    expect(r.motivoDaParada).toBe('drive_cheio');
    expect(r.progresso.enviadas).toBe(1);
    expect(c.destino.contar('enviarArquivo')).toBe(2);
  });

  it('429 com Retry-After: espera exatamente o que o Google pediu e tenta de novo', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    c.destino.falhasDeEnvio = [new DestinoLimitouError(7000)];
    const r = await enviar(c);
    expect(r.progresso.enviadas).toBe(1);
    expect(c.esperas).toContain(7000);
  });

  it('429 sem Retry-After: backoff exponencial, e LIMITADO — depois o lote para (sem laço infinito)', async () => {
    const c = montarCenario([peca(1), peca(2)]);
    await c.conectar();
    c.destino.falhaPorNome.set(
      '0001 - Petição 1 - 11-09-2026.pdf',
      new DestinoLimitouError(undefined),
    );
    const r = await enviar(c);
    expect(r.estado).toBe('interrompido');
    expect(r.motivoDaParada).toBe('limite_de_uso');
    expect(c.destino.contar('enviarArquivo')).toBe(MAXIMO_DE_TENTATIVAS);
    expect(c.esperas.filter((ms) => ms > 0)).toEqual([1000, 2000, 4000]);
  });

  it('Retry-After maior que o teto: não espera — o lote para dizendo "limite de uso"', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    c.destino.falhasDeEnvio = [new DestinoLimitouError(TETO_DA_ESPERA_MS + 1)];
    const r = await enviar(c);
    expect(r.motivoDaParada).toBe('limite_de_uso');
    expect(c.esperas.filter((ms) => ms > 0)).toEqual([]);
    expect(c.destino.contar('enviarArquivo')).toBe(1);
  });

  it('5xx passageiro: repete com backoff e a peça vai', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    c.destino.falhasDeEnvio = [
      new DestinoIndisponivelError(503),
      new DestinoIndisponivelError(500),
    ];
    const r = await enviar(c);
    expect(r.progresso.enviadas).toBe(1);
    expect(c.esperas.filter((ms) => ms > 0)).toEqual([1000, 2000]);
  });

  it('5xx teimoso: a peça falha, e três falhas seguidas encerram o lote', async () => {
    const c = montarCenario([peca(1), peca(2), peca(3), peca(4)]);
    await c.conectar();
    for (const n of [1, 2, 3, 4]) {
      c.destino.falhaPorNome.set(
        `000${n} - Petição ${n} - ${10 + n}-09-2026.pdf`,
        new DestinoIndisponivelError(503),
      );
    }
    const r = await enviar(c);
    expect(r.estado).toBe('interrompido');
    expect(r.motivoDaParada).toBe('drive_indisponivel');
    expect(r.progresso.falhas).toBe(3);
    expect(c.destino.contar('enviarArquivo')).toBe(3 * MAXIMO_DE_TENTATIVAS);
  });

  it('o Drive recusa uma peça (4xx): só ela falha, o lote segue', async () => {
    const c = montarCenario([peca(1), peca(2)]);
    await c.conectar();
    c.destino.falhasDeEnvio = [new DestinoRecusouError(400)];
    const r = await enviar(c);
    expect(r.estado).toBe('concluido');
    expect(r.falhasDasPecas).toEqual([{ pecaId: 'p1', motivo: 'recusada_pelo_drive' }]);
    expect(r.progresso.enviadas).toBe(1);
  });
});

describe('ServicoDrive — pasta apagada', () => {
  it('pasta raiz na lixeira: recriada UMA vez, o aviso é registrado e as subpastas recomeçam', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    await enviar(c);
    const raiz = (await c.repo.conexao(WS))?.pastaRaiz?.id as string;
    c.destino.apagarPasta(raiz);
    c.fonte.guarda.set('p1', {
      bytes: new TextEncoder().encode('v2'),
      conversao: 'nenhuma',
    });
    // O arquivo estava dentro da raiz que sumiu: no Drive real ele vem como removido.
    c.destino.apagarArquivo(c.destino.envios[0]?.id as string);
    const r = await enviar(c, 'todas', { reenviarRemovidas: true });
    expect(r.avisos).toContain('pasta_raiz_recriada');
    expect(r.estado).toBe('concluido');
    const nova = (await c.repo.conexao(WS))?.pastaRaiz?.id;
    expect(nova).not.toBe(raiz);
    expect((await c.repo.conexao(WS))?.motivoDoUltimoErro).toBe('pasta_raiz_recriada');
    const criadas = c.destino.chamadas.filter(
      (x) => x.op === 'garantirPasta' && x.detalhe?.['nome'] === NOME_DA_PASTA_RAIZ,
    );
    // Uma ao conectar, uma ao recriar — não mais que isso.
    expect(criadas).toHaveLength(3);
  });

  it('subpasta do processo na lixeira: recriada, com o aviso', async () => {
    const c = montarCenario([peca(1), peca(2)]);
    await c.conectar();
    await enviar(c, ['p1']);
    const sub = (await c.repo.pastaDoProcesso(WS, NUMERO))?.pasta.id as string;
    c.destino.apagarPasta(sub);
    const r = await enviar(c, ['p2']);
    expect(r.avisos).toContain('pasta_do_processo_recriada');
    expect((await c.repo.pastaDoProcesso(WS, NUMERO))?.pasta.id).not.toBe(sub);
    expect(r.progresso.enviadas).toBe(1);
  });

  it('o pai some no MEIO do envio: recria a subpasta uma vez e repete a peça', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    c.destino.falhasDeEnvio = [new PastaRemovidaNoDestinoError()];
    const r = await enviar(c);
    expect(r.progresso.enviadas).toBe(1);
    expect(r.avisos).toContain('pasta_do_processo_recriada');
  });

  it('o pai some DE NOVO logo depois: não entra em laço — a peça falha', async () => {
    const c = montarCenario([peca(1)]);
    await c.conectar();
    c.destino.falhasDeEnvio = [
      new PastaRemovidaNoDestinoError(),
      new PastaRemovidaNoDestinoError(),
    ];
    const r = await enviar(c);
    expect(r.progresso.falhas).toBe(1);
    expect(c.destino.contar('enviarArquivo')).toBe(2);
  });
});
