param(
    [Parameter(Mandatory=$false)]
    [string]$Password = $env:CERT_PASSWORD
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path "certs")) {
    New-Item -ItemType Directory -Force -Path "certs" | Out-Null
}

Write-Host "Generando certificado autofirmado para UPick SAS..."
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=UPick SAS, O=UPick SAS" -CertStoreLocation "Cert:\CurrentUser\My" -NotAfter (Get-Date).AddYears(10)

if ([string]::IsNullOrWhiteSpace($Password)) {
    $pwd = Read-Host "Ingresa la contraseña para el certificado PFX" -AsSecureString
} else {
    $pwd = ConvertTo-SecureString -String $Password -Force -AsPlainText
}

Write-Host "Exportando PFX a certs/upick-codesign.pfx..."
Export-PfxCertificate -Cert $cert -FilePath "certs\upick-codesign.pfx" -Password $pwd | Out-Null

Write-Host "Exportando CER a certs/upick.cer..."
Export-Certificate -Cert $cert -FilePath "certs\upick.cer" | Out-Null

Write-Host "Certificado generado exitosamente."
