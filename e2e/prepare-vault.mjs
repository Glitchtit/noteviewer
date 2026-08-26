import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

rmSync('e2e/.vault', { recursive: true, force: true });
mkdirSync('e2e/.vault/sub', { recursive: true });
writeFileSync('e2e/.vault/Welcome.md', '# Welcome\n\nHello from the fixture vault. See [[sub/Other]].\n');
writeFileSync('e2e/.vault/sub/Other.md', '# Other\n\nAnother note.\n');
