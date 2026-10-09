/**
 * As inscrições na OAB que pertencem a um workspace: a que a pessoa informou no
 * cadastro e as que ela pôs sob vigilância. Serve para saber se uma comunicação
 * do Diário é DIRIGIDA a quem acompanha o processo (v0.37.6).
 *
 * Devolve chaves de comparação (`47383/GO`, ver `chaveDeOab`) e só lê.
 * Conjunto vazio = o workspace não cadastrou OAB nenhuma, e então o destinatário
 * é desconhecido — nunca "de outro".
 */
export interface OabsDoWorkspace {
  chaves(workspace: string): Promise<ReadonlySet<string>>;
}
