// TEMPORÁRIO: diagnóstico do qpdf do runner. Sai antes do merge.
import { PDFDocument, StandardFonts, PDFName, PDFString } from 'pdf-lib';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const doc = await PDFDocument.create();
const f = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 3; i++) { const p = doc.addPage([300, 300]); p.drawText('x' + i, { x: 20, y: 150, font: f, size: 12 }); p.node.set(PDFName.of('PVMarca'), PDFString.of('m' + i)); }
const bytes = await doc.save();
const d = mkdtempSync(join(tmpdir(), 'dq-'));
mkdirSync(join(d, 'pecas'), { mode: 0o700 });
const alvos = [join(d, 'a.pdf'), join(d, 'pecas', '0.bin'), join(d, 'pecas', '1.bin'), join(d, 'semext')];
for (const a of alvos) writeFileSync(a, bytes, { mode: 0o600 });
for (const a of alvos) {
  for (const args of [['--show-npages', a], ['--show-npages', '--', a], ['--check', a]]) {
    const r = spawnSync('qpdf', args, { encoding: 'utf8' });
    console.log(JSON.stringify({ args: args.map((x) => x.replace(d, 'D')), status: r.status, out: r.stdout.slice(0, 300), err: r.stderr.slice(0, 300) }));
  }
}
