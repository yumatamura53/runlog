// 各モジュールが import している名前が、相手のモジュールに本当にあるか（読み込み失敗で真っ白になるのを防ぐ）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

test('import している名前がすべて export されている', async () => {
  const dir = new URL('../js/', import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([\w.]+)'/g)) {
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      const target = fs.readFileSync(new URL(m[2], dir), 'utf8');
      for (const n of names) {
        assert.ok(new RegExp(`export (?:async )?(?:function|const|let|class) ${n}\\b|export \\{[^}]*\\b${n}\\b`).test(target), `${f} → ${m[2]} の ${n}`);
      }
    }
  }
});
