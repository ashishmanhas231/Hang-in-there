"""
Builds dist/<name>-<version>.vsix without vsce.

Step 1: publishes the desktop overlay (desktop/) into bin/ with `dotnet publish`.
        It is framework-dependent, so it needs the .NET 10 Desktop Runtime on the PC.
        Do NOT add -r win-x64 to that command. It silently bundles the whole runtime (~165 MB).
        Pass --skip-dotnet to reuse what is already in bin/.

Step 2: zips everything. A .vsix is a zip with two extra files at the top:
        [Content_Types].xml and extension.vsixmanifest. Shipped files go under extension/.

Entry names MUST use forward slashes. Windows' Compress-Archive writes backslashes and VS Code
then refuses to install the file. That is why this uses zipfile.
"""
import json
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
SHIPPED = ["package.json", "extension.js", "README.md", "LICENSE", "media/hang.js", "media/hang.css", "media/icon.svg"]
DESKTOP = ["bin/SpideyHang.exe", "bin/SpideyHang.dll", "bin/SpideyHang.runtimeconfig.json", "bin/SpideyHang.deps.json"]

CONTENT_TYPES = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".css" ContentType="text/css"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".txt" ContentType="text/plain"/>
  <Default Extension=".exe" ContentType="application/octet-stream"/>
  <Default Extension=".dll" ContentType="application/octet-stream"/>
</Types>
"""

MANIFEST = """<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{name}" Version="{version}" Publisher="{publisher}"/>
    <DisplayName>{display}</DisplayName>
    <Description xml:space="preserve">{description}</Description>
    <Tags>{tags}</Tags>
    <Categories>{categories}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{engine}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
"""


def publish_desktop():
    subprocess.run(
        ["dotnet", "publish", "desktop/SpideyHang.Desktop.csproj", "-c", "Release", "-p:DebugType=none", "-o", "bin"],
        cwd=ROOT,
        check=True,
    )


def main():
    if "--skip-dotnet" not in sys.argv:
        publish_desktop()
    missing = [rel for rel in DESKTOP if not (ROOT / rel).exists()]
    if missing:
        sys.exit(f"Desktop app not built. Missing: {', '.join(missing)}")

    # utf-8-sig: tolerate a byte-order mark (PowerShell 5.1 adds one when it writes UTF-8).
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8-sig"))
    manifest = MANIFEST.format(
        name=escape(pkg["name"]),
        version=escape(pkg["version"]),
        publisher=escape(pkg["publisher"]),
        display=escape(pkg["displayName"]),
        description=escape(pkg["description"]),
        tags=escape(",".join(pkg.get("keywords", []))),
        categories=escape(",".join(pkg.get("categories", ["Other"]))),
        engine=escape(pkg["engines"]["vscode"]),
    )

    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    out = dist / f"{pkg['name']}-{pkg['version']}.vsix"

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("extension.vsixmanifest", manifest)
        for rel in SHIPPED + DESKTOP:
            # The licence is listed as LICENSE.txt in the manifest, so ship it under that name.
            target = "LICENSE.txt" if rel == "LICENSE" else rel
            z.write(ROOT / rel, f"extension/{target}")

    print(f"Wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
