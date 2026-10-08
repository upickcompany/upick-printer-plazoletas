$ErrorActionPreference = "Stop"

if (-not (Test-Path "certs")) {
    New-Item -ItemType Directory -Force -Path "certs" | Out-Null
}

Write-Host "Generando certificado autofirmado para UPick SAS..."
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=UPick SAS, O=UPick SAS" -CertStoreLocation "Cert:\CurrentUser\My" -NotAfter (Get-Date).AddYears(10)

$pwd = ConvertTo-SecureString -String "UPick2026!" -Force -AsPlainText

Write-Host "Exportando PFX a certs/upick-codesign.pfx..."
Export-PfxCertificate -Cert $cert -FilePath "certs\upick-codesign.pfx" -Password $pwd | Out-Null

Write-Host "Exportando CER a certs/upick.cer..."
Export-Certificate -Cert $cert -FilePath "certs\upick.cer" | Out-Null

Write-Host "Certificado generado exitosamente."
