import { spawn } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('请通过 npm run dev 启动开发服务');
const children = ['@river/api', '@river/web'].map((workspace) =>
  spawn(process.execPath, [npmCli, 'run', 'dev', '-w', workspace], { stdio: 'inherit' })
);

const stop = () => children.forEach((child) => child.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
