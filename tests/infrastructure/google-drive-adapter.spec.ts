import { describe, expect, it } from 'vitest';
import type { AutorizacaoDoDestino } from '../../src/domain/entities/DestinoDePecas.js';
import {
  ArquivoRemovidoNoDestinoError,
  AutorizacaoDoDestinoRevogadaError,
  AutorizacaoDoDestinoVencidaError,
  DestinoIndisponivelError,
  DestinoLimitouError,
  DestinoRecusouError,
  DestinoSemEspacoError,
  PastaRemovidaNoDestinoError,
} from '../../src/domain/errors/index.js';
import {
  ESCOPO_DO_DRIVE,
  GoogleDriveAdapter,
  LIMITE_DO_UPLOAD_SIMPLES_BYTES,
  TAMANHO_DO_PEDACO_BYTES,
} from '../../src/infrastructure/adapters/drive/GoogleDriveAdapter.js';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  CODIGO_DO_GOOGLE,
  TOKEN_DE_ACESSO,
  TOKEN_DE_RENOVACAO,
  TransporteFalso,
  arquivoJson,
  bytesDeTexto,
  conteudoDeBytes,
  erroDoGoogle,
  resposta,
  textoDoCorpo,
  tokenJson,
} from '../helpers/transporteDoDrive.js';

const AGORA = new Date('2026-10-14T12:00:00.000Z');
const URI = 'https://app.exemplo.test/v1/drive/retorno';
const AUTORIZACAO: AutorizacaoDoDestino = {
  tokenDeAcesso: TOKEN_DE_ACESSO,
  tokenDeRenovacao: TOKEN_DE_RENOVACAO,
  expiraEm: new Date(AGORA.getTime() + 3_600_000),
};

function montar(
  opcoes: { limiteSimplesBytes?: number; tamanhoDoPedacoBytes?: number } = {},
) {
  const transporte = new TransporteFalso();
  const adapter = new GoogleDriveAdapter({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    transporte,
    clock: { agora: () => AGORA, monotonico: () => 0 },
    ...opcoes,
  });
  return { transporte, adapter };
}

async function erroDe(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('devia ter lançado');
}

describe('GoogleDriveAdapter — autorização', () => {
  it('pede UM escopo só, `drive.file`, e nada mais amplo', () => {
    expect(ESCOPO_DO_DRIVE).toBe('https://www.googleapis.com/auth/drive.file');
    const { adapter } = montar();
    const { url } = adapter.iniciarConexao({
      estado: 'ST',
      desafio: 'DESAFIO',
      uriDeRetorno: URI,
    });
    const q = new URL(url).searchParams;
    expect(q.get('scope')).toBe(ESCOPO_DO_DRIVE);
    expect(url).not.toMatch(/auth%2Fdrive(?!\.file)|auth\/drive(?!\.file)/);
  });

  it('a URL de autorização leva state, PKCE S256, refresh token (offline + consent) e o retorno', () => {
    const { adapter } = montar();
    const { url } = adapter.iniciarConexao({
      estado: 'ST',
      desafio: 'DESAFIO',
      uriDeRetorno: URI,
    });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    const q = u.searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('redirect_uri')).toBe(URI);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('state')).toBe('ST');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('code_challenge')).toBe('DESAFIO');
    expect(q.get('code_challenge_method')).toBe('S256');
    // O segredo do cliente NUNCA vai para a URL que o navegador mostra.
    expect(url).not.toContain(CLIENT_SECRET);
  });

  it('troca o código pela autorização com PKCE e o segredo no corpo (não na URL)', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(tokenJson());
    const a = await adapter.concluirConexao({
      codigo: CODIGO_DO_GOOGLE,
      verificador: 'VERIF',
      uriDeRetorno: URI,
    });
    expect(a.tokenDeAcesso).toBe(TOKEN_DE_ACESSO);
    expect(a.tokenDeRenovacao).toBe(TOKEN_DE_RENOVACAO);
    expect(a.expiraEm.getTime()).toBe(AGORA.getTime() + 3599 * 1000);

    const p = transporte.pedidos[0]!;
    expect(p.url).toBe('https://oauth2.googleapis.com/token');
    expect(p.metodo).toBe('POST');
    const corpo = new URLSearchParams(textoDoCorpo(p));
    expect(corpo.get('grant_type')).toBe('authorization_code');
    expect(corpo.get('code')).toBe(CODIGO_DO_GOOGLE);
    expect(corpo.get('code_verifier')).toBe('VERIF');
    expect(corpo.get('client_secret')).toBe(CLIENT_SECRET);
    expect(p.url).not.toContain(CODIGO_DO_GOOGLE);
  });

  it('recusa a conexão quando o advogado desmarcou a permissão da pasta (consentimento granular)', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(tokenJson({ scope: 'openid' }));
    const e = await erroDe(
      adapter.concluirConexao({
        codigo: CODIGO_DO_GOOGLE,
        verificador: 'V',
        uriDeRetorno: URI,
      }),
    );
    expect(e).toBeInstanceOf(AutorizacaoDoDestinoRevogadaError);
    expect((e as AutorizacaoDoDestinoRevogadaError).motivo).toBe('escopo_negado');
  });

  it('recusa a conexão sem token de renovação (cairia em uma hora)', async () => {
    const { adapter, transporte } = montar();
    const sem = JSON.parse(new TextDecoder().decode(tokenJson().bytes)) as Record<
      string,
      unknown
    >;
    delete sem['refresh_token'];
    transporte.responder(resposta(200, sem));
    const e = await erroDe(
      adapter.concluirConexao({ codigo: 'c', verificador: 'V', uriDeRetorno: URI }),
    );
    expect(e).toBeInstanceOf(AutorizacaoDoDestinoRevogadaError);
  });

  it('`invalid_grant` na renovação vira "autorização revogada" (reconectar)', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(
      resposta(400, {
        error: 'invalid_grant',
        error_description: 'Token has been expired',
      }),
    );
    const e = await erroDe(adapter.renovarAutorizacao(AUTORIZACAO));
    expect(e).toBeInstanceOf(AutorizacaoDoDestinoRevogadaError);
    expect((e as AutorizacaoDoDestinoRevogadaError).motivo).toBe('revogada');
  });

  it('renova mantendo o token de renovação antigo quando o Google não manda outro', async () => {
    const { adapter, transporte } = montar();
    const sem = JSON.parse(
      new TextDecoder().decode(tokenJson({ access_token: 'NOVO' }).bytes),
    ) as Record<string, unknown>;
    delete sem['refresh_token'];
    transporte.responder(resposta(200, sem));
    const nova = await adapter.renovarAutorizacao(AUTORIZACAO);
    expect(nova.tokenDeAcesso).toBe('NOVO');
    expect(nova.tokenDeRenovacao).toBe(TOKEN_DE_RENOVACAO);
    const corpo = new URLSearchParams(textoDoCorpo(transporte.pedidos[0]!));
    expect(corpo.get('grant_type')).toBe('refresh_token');
    expect(corpo.get('refresh_token')).toBe(TOKEN_DE_RENOVACAO);
  });

  it('desconectar revoga o token de renovação e NUNCA lança, mesmo com o Google fora do ar', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(resposta(200, {}), new Error('rede caiu'));
    await adapter.desconectar(AUTORIZACAO);
    expect(transporte.pedidos[0]!.url).toBe('https://oauth2.googleapis.com/revoke');
    expect(new URLSearchParams(textoDoCorpo(transporte.pedidos[0]!)).get('token')).toBe(
      TOKEN_DE_RENOVACAO,
    );
    await expect(adapter.desconectar(AUTORIZACAO)).resolves.toBeUndefined();
  });

  it('healthCheck nunca lança: fora do ar é false', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(resposta(200, {}), resposta(503, {}), new Error('rede'));
    expect(await adapter.healthCheck()).toBe(true);
    expect(await adapter.healthCheck()).toBe(false);
    expect(await adapter.healthCheck()).toBe(false);
  });
});

describe('GoogleDriveAdapter — pastas', () => {
  it('cria a pasta raiz sem pai, com o token no cabeçalho (nunca na URL)', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(arquivoJson('raiz-1'));
    const r = await adapter.garantirPasta(AUTORIZACAO, { nome: 'Processo Vivo' });
    expect(r).toEqual({
      pasta: { id: 'raiz-1', link: 'https://drive.google.com/drive/folders/raiz-1' },
      recriada: false,
    });
    const p = transporte.pedidos[0]!;
    expect(p.metodo).toBe('POST');
    expect(p.headers?.['authorization']).toBe(`Bearer ${TOKEN_DE_ACESSO}`);
    expect(p.url).not.toContain(TOKEN_DE_ACESSO);
    expect(JSON.parse(textoDoCorpo(p))).toEqual({
      name: 'Processo Vivo',
      mimeType: 'application/vnd.google-apps.folder',
    });
  });

  it('cria a subpasta dentro da raiz', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(arquivoJson('sub-1'));
    await adapter.garantirPasta(AUTORIZACAO, {
      nome: '9999901-96.2026.8.09.9999',
      paiId: 'raiz-1',
    });
    expect(JSON.parse(textoDoCorpo(transporte.pedidos[0]!)).parents).toEqual(['raiz-1']);
  });

  it('pasta conhecida que ainda existe é reaproveitada (uma consulta, nenhuma criação)', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(arquivoJson('raiz-1', { trashed: false }));
    const r = await adapter.garantirPasta(AUTORIZACAO, {
      nome: 'Processo Vivo',
      idConhecido: 'raiz-1',
    });
    expect(r.recriada).toBe(false);
    expect(r.pasta.id).toBe('raiz-1');
    expect(transporte.pedidos).toHaveLength(1);
    expect(transporte.pedidos[0]!.metodo).toBe('GET');
  });

  it('pasta na lixeira é recriada UMA vez, e a resposta diz que foi recriada', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(arquivoJson('raiz-1', { trashed: true }), arquivoJson('raiz-2'));
    const r = await adapter.garantirPasta(AUTORIZACAO, {
      nome: 'Processo Vivo',
      idConhecido: 'raiz-1',
    });
    expect(r.recriada).toBe(true);
    expect(r.pasta.id).toBe('raiz-2');
    expect(transporte.pedidos.map((p) => p.metodo)).toEqual(['GET', 'POST']);
  });

  it('pasta apagada de vez (404) também é recriada', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(erroDoGoogle(404, 'notFound'), arquivoJson('raiz-2'));
    const r = await adapter.garantirPasta(AUTORIZACAO, {
      nome: 'Processo Vivo',
      idConhecido: 'raiz-1',
    });
    expect(r.recriada).toBe(true);
  });

  it('nunca procura pasta pelo nome: o escopo não permite listar', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(arquivoJson('x'));
    await adapter.garantirPasta(AUTORIZACAO, { nome: 'Processo Vivo' });
    for (const p of transporte.pedidos) {
      expect(p.url).not.toMatch(/[?&]q=/);
      expect(p.metodo).not.toBe('DELETE');
    }
  });

  it('conferirArquivo: existe, na lixeira e apagado de vez', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(
      arquivoJson('a', { trashed: false }),
      arquivoJson('a', { trashed: true }),
      erroDoGoogle(404, 'notFound'),
    );
    expect(await adapter.conferirArquivo(AUTORIZACAO, 'a')).toBe('existe');
    expect(await adapter.conferirArquivo(AUTORIZACAO, 'a')).toBe('removido');
    expect(await adapter.conferirArquivo(AUTORIZACAO, 'a')).toBe('removido');
  });
});

describe('GoogleDriveAdapter — envio', () => {
  const PDF = bytesDeTexto('%PDF-1.4 conteúdo sintético de uma peça');

  it('arquivo pequeno vai num único pedido multipart, com metadados e o conteúdo intacto', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(arquivoJson('arq-1'));
    const r = await adapter.enviarArquivo(AUTORIZACAO, {
      nome: '0123 - Decisão - 14-10-2026.pdf',
      paiId: 'sub-1',
      mimetype: 'application/pdf',
      conteudo: conteudoDeBytes(PDF),
      descricao: 'Peça convertida pelo Processo Vivo.',
    });
    expect(r.id).toBe('arq-1');
    expect(transporte.pedidos).toHaveLength(1);
    const p = transporte.pedidos[0]!;
    expect(p.metodo).toBe('POST');
    expect(p.url).toContain(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    );
    expect(p.headers?.['content-type']).toMatch(/^multipart\/related; boundary=pv-/);
    const corpo = textoDoCorpo(p);
    expect(corpo).toContain('"name":"0123 - Decisão - 14-10-2026.pdf"');
    expect(corpo).toContain('"parents":["sub-1"]');
    expect(corpo).toContain('"description":"Peça convertida pelo Processo Vivo."');
    expect(corpo).toContain('%PDF-1.4 conteúdo sintético de uma peça');
    expect(corpo.trimEnd().endsWith('--')).toBe(true);
  });

  it('atualizar o MESMO arquivo usa PATCH no id, sem `parents` (ele fica onde o advogado o deixou)', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(arquivoJson('arq-1'));
    await adapter.enviarArquivo(AUTORIZACAO, {
      nome: 'novo nome.pdf',
      paiId: 'sub-1',
      mimetype: 'application/pdf',
      conteudo: conteudoDeBytes(PDF),
      arquivoId: 'arq-1',
    });
    const p = transporte.pedidos[0]!;
    expect(p.metodo).toBe('PATCH');
    expect(p.url).toContain('/upload/drive/v3/files/arq-1?uploadType=multipart');
    expect(textoDoCorpo(p)).not.toContain('"parents"');
  });

  it('arquivo grande usa upload resumível, em pedaços, com Content-Range correto', async () => {
    const { adapter, transporte } = montar({
      limiteSimplesBytes: 10,
      tamanhoDoPedacoBytes: 16,
    });
    const grande = bytesDeTexto('A'.repeat(40));
    transporte.responder(
      resposta(200, {}, { location: 'https://upload.exemplo.test/sessao-1' }),
      resposta(308, {}, { range: 'bytes=0-15' }),
      resposta(308, {}, { range: 'bytes=0-31' }),
      arquivoJson('arq-grande'),
    );
    const r = await adapter.enviarArquivo(AUTORIZACAO, {
      nome: 'grande.pdf',
      paiId: 'sub-1',
      mimetype: 'application/pdf',
      conteudo: conteudoDeBytes(grande),
    });
    expect(r.id).toBe('arq-grande');
    const [abertura, a, b, c] = transporte.pedidos as [
      (typeof transporte.pedidos)[number],
      (typeof transporte.pedidos)[number],
      (typeof transporte.pedidos)[number],
      (typeof transporte.pedidos)[number],
    ];
    expect(abertura.url).toContain('uploadType=resumable');
    expect(abertura.headers?.['x-upload-content-length']).toBe('40');
    expect(abertura.headers?.['x-upload-content-type']).toBe('application/pdf');
    expect(a.metodo).toBe('PUT');
    expect(a.url).toBe('https://upload.exemplo.test/sessao-1');
    expect(a.headers?.['content-range']).toBe('bytes 0-15/40');
    expect(b.headers?.['content-range']).toBe('bytes 16-31/40');
    expect(c.headers?.['content-range']).toBe('bytes 32-39/40');
    // A sessão já identifica o upload: o token de acesso NÃO vai junto.
    expect(a.headers?.['authorization']).toBeUndefined();
  });

  it('resumível: uma falha de rede no meio pergunta ao Google quanto ele recebeu e continua dali', async () => {
    const { adapter, transporte } = montar({
      limiteSimplesBytes: 10,
      tamanhoDoPedacoBytes: 16,
    });
    transporte.responder(
      resposta(200, {}, { location: 'https://upload.exemplo.test/s' }),
      resposta(308, {}, { range: 'bytes=0-15' }),
      new Error('conexão caiu'),
      resposta(308, {}, { range: 'bytes=0-23' }),
      arquivoJson('arq-grande'),
    );
    const r = await adapter.enviarArquivo(AUTORIZACAO, {
      nome: 'g.pdf',
      paiId: 'sub',
      mimetype: 'application/pdf',
      conteudo: conteudoDeBytes(bytesDeTexto('B'.repeat(40))),
    });
    expect(r.id).toBe('arq-grande');
    const consulta = transporte.pedidos[3]!;
    expect(consulta.headers?.['content-range']).toBe('bytes */40');
    expect(transporte.pedidos[4]!.headers?.['content-range']).toBe('bytes 24-39/40');
  });

  it('resumível: duas falhas seguidas no mesmo pedaço sobem (o serviço repete a peça com espera)', async () => {
    const { adapter, transporte } = montar({
      limiteSimplesBytes: 10,
      tamanhoDoPedacoBytes: 16,
    });
    transporte.responder(
      resposta(200, {}, { location: 'https://upload.exemplo.test/s' }),
      new Error('caiu'),
      resposta(308, {}, {}),
      resposta(503, {}),
    );
    const e = await erroDe(
      adapter.enviarArquivo(AUTORIZACAO, {
        nome: 'g.pdf',
        paiId: 'sub',
        mimetype: 'application/pdf',
        conteudo: conteudoDeBytes(bytesDeTexto('C'.repeat(40))),
      }),
    );
    expect(e).toBeInstanceOf(DestinoIndisponivelError);
  });

  it('os limites de produção estão em constantes nomeadas (5 MiB simples; pedaços de 8 MiB, múltiplos de 256 KiB)', () => {
    expect(LIMITE_DO_UPLOAD_SIMPLES_BYTES).toBe(5 * 1024 * 1024);
    expect(TAMANHO_DO_PEDACO_BYTES).toBe(8 * 1024 * 1024);
    expect(TAMANHO_DO_PEDACO_BYTES % (256 * 1024)).toBe(0);
  });
});

describe('GoogleDriveAdapter — erros do Google viram erros do domínio, sem texto do Google', () => {
  const envio = (adapter: GoogleDriveAdapter, arquivoId?: string) =>
    adapter.enviarArquivo(AUTORIZACAO, {
      nome: 'a.pdf',
      paiId: 'sub',
      mimetype: 'application/pdf',
      conteudo: conteudoDeBytes(bytesDeTexto('x')),
      ...(arquivoId ? { arquivoId } : {}),
    });

  it('401 é "autorização vencida" (renova e repete), não "revogada"', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(resposta(401, { error: { code: 401 } }));
    expect(await erroDe(envio(adapter))).toBeInstanceOf(AutorizacaoDoDestinoVencidaError);
  });

  it('403 storageQuotaExceeded é "Drive cheio"', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(erroDoGoogle(403, 'storageQuotaExceeded'));
    expect(await erroDe(envio(adapter))).toBeInstanceOf(DestinoSemEspacoError);
  });

  it('403 de limite de uso e 429 viram "limitou", com o Retry-After em milissegundos', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(
      erroDoGoogle(403, 'userRateLimitExceeded', { 'retry-after': '7' }),
      erroDoGoogle(429, 'rateLimitExceeded', { 'retry-after': '3' }),
      erroDoGoogle(429, 'rateLimitExceeded'),
    );
    const a = await erroDe(envio(adapter));
    const b = await erroDe(envio(adapter));
    const c = await erroDe(envio(adapter));
    expect(a).toBeInstanceOf(DestinoLimitouError);
    expect((a as DestinoLimitouError).esperarMs).toBe(7000);
    expect((b as DestinoLimitouError).esperarMs).toBe(3000);
    expect((c as DestinoLimitouError).esperarMs).toBeUndefined();
  });

  it('Retry-After em data HTTP é convertido pela diferença para agora', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(
      erroDoGoogle(429, 'rateLimitExceeded', {
        'retry-after': new Date(AGORA.getTime() + 12_000).toUTCString(),
      }),
    );
    const e = await erroDe(envio(adapter));
    expect((e as DestinoLimitouError).esperarMs).toBe(12_000);
  });

  it('5xx e queda de rede viram "indisponível" — sem a mensagem original (que carrega URL)', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(
      erroDoGoogle(503, 'backendError'),
      new Error('ECONNRESET https://segredo.exemplo/sessao'),
    );
    const a = await erroDe(envio(adapter));
    const b = await erroDe(envio(adapter));
    expect(a).toBeInstanceOf(DestinoIndisponivelError);
    expect(b).toBeInstanceOf(DestinoIndisponivelError);
    expect(String((b as Error).message)).not.toContain('segredo.exemplo');
  });

  it('403 de permissão vira "escopo negado"; outro 403 e outros 4xx viram "recusou"', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(
      erroDoGoogle(403, 'insufficientPermissions'),
      erroDoGoogle(403, 'forbidden'),
      erroDoGoogle(400, 'badRequest'),
    );
    const a = await erroDe(envio(adapter));
    expect(a).toBeInstanceOf(AutorizacaoDoDestinoRevogadaError);
    expect((a as AutorizacaoDoDestinoRevogadaError).motivo).toBe('escopo_negado');
    const b = await erroDe(envio(adapter));
    expect(b).toBeInstanceOf(DestinoRecusouError);
    expect((b as DestinoRecusouError).status).toBe(403);
    const c = await erroDe(envio(adapter));
    expect((c as DestinoRecusouError).status).toBe(400);
  });

  it('404 na criação é "pasta removida"; 404 na atualização é "arquivo removido"', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(erroDoGoogle(404, 'notFound'), erroDoGoogle(404, 'notFound'));
    expect(await erroDe(envio(adapter))).toBeInstanceOf(PastaRemovidaNoDestinoError);
    expect(await erroDe(envio(adapter, 'arq-1'))).toBeInstanceOf(
      ArquivoRemovidoNoDestinoError,
    );
  });

  it('nenhum erro carrega a mensagem do Google, o token ou o segredo do cliente', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(
      erroDoGoogle(403, 'forbidden'),
      erroDoGoogle(500, 'backendError'),
      resposta(400, { error: 'invalid_client', error_description: CLIENT_SECRET }),
    );
    const erros = [
      await erroDe(envio(adapter)),
      await erroDe(envio(adapter)),
      await erroDe(adapter.renovarAutorizacao(AUTORIZACAO)),
    ];
    for (const e of erros) {
      const texto =
        JSON.stringify(e, Object.getOwnPropertyNames(e)) + String((e as Error).stack);
      expect(texto).not.toContain('MENSAGEM-DO-GOOGLE-NAO-PODE-VAZAR');
      expect(texto).not.toContain(TOKEN_DE_ACESSO);
      expect(texto).not.toContain(TOKEN_DE_RENOVACAO);
      expect(texto).not.toContain(CLIENT_SECRET);
    }
  });

  it('resposta fora do contrato não vira arquivo com id inventado', async () => {
    const { adapter, transporte } = montar();
    transporte.responder(resposta(200, { semId: true }));
    await expect(envio(adapter)).rejects.toThrow(/fora do contrato/);
  });
});
