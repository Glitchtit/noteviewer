import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

rmSync('e2e/.vault', { recursive: true, force: true });
mkdirSync('e2e/.vault/sub', { recursive: true });
writeFileSync('e2e/.vault/Welcome.md', '# Welcome\n\nHello from the fixture vault. See [[sub/Other]].\n');
writeFileSync('e2e/.vault/sub/Other.md', '# Other\n\nAnother note.\n');
writeFileSync('e2e/.vault/Rich.md', '# Rich\n\nSome **bold** text with [[Welcome]] and math $x^2$.\n');
writeFileSync(
  'e2e/.vault/Board.md',
  '---\nkanban-plugin: board\n---\n\n## Todo\n\n- [ ] Write tests\n\n## Done\n',
);
