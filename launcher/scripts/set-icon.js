// Ставит иконку ProjectX на exe без wine/rcedit (сборка из Linux). Вызывается electron-builder как afterPack.
const fs = require('node:fs');
const path = require('node:path');
module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const { NtExecutable, NtExecutableResource, Resource, Data } = ResEdit.default ?? ResEdit;
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  const icon = Data.IconFile.from(fs.readFileSync(path.join(context.packager.projectDir, 'assets', 'icon.ico')));
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  const id = groups[0]?.id ?? 1, lang = groups[0]?.lang ?? 1033;
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, icon.icons.map(item => item.data));
  const [info] = Resource.VersionInfo.fromEntries(res.entries);
  if (info) {
    const version = context.packager.appInfo.version.split('.').map(Number);
    info.setFileVersion(...version, 0); info.setProductVersion(...version, 0);
    info.setStringValues({ lang: 1033, codepage: 1200 }, { FileDescription: 'ProjectX', ProductName: 'ProjectX', CompanyName: 'ProjectX', OriginalFilename: 'ProjectX-FunPay.exe' });
    info.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('  • icon set', exePath);
};
