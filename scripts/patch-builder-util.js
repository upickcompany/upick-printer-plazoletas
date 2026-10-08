import fs from 'fs';
import path from 'path';

const filePath = path.resolve('node_modules/builder-util/out/util.js');

if (fs.existsSync(filePath)) {
  let content = fs.readFileSync(filePath, 'utf8');
  const target = 'return env == null ? undefined : env;';
  const replacement = 'return env == null ? undefined : { ...process.env, ...env };';

  if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('[postinstall] Parche aplicado con éxito a builder-util para Windows.');
  }
}

const wineVmPath = path.resolve('node_modules/app-builder-lib/out/vm/WineVm.js');
if (fs.existsSync(wineVmPath)) {
  let content = fs.readFileSync(wineVmPath, 'utf8');
  const target = 'return (0, builder_util_1.exec)(target, appArgs, options);';
  const replacement = `let lastErr;
            for (let attempt = 0; attempt < 6; attempt++) {
                try {
                    return await (0, builder_util_1.exec)(target, appArgs, options);
                } catch (err) {
                    lastErr = err;
                    if (attempt < 5) {
                        await new Promise(r => setTimeout(r, 1000));
                        continue;
                    }
                    throw err;
                }
            }
            throw lastErr;`;

  if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(wineVmPath, content, 'utf8');
    console.log('[postinstall] Parche aplicado con éxito a WineVm para Windows.');
  }
}
