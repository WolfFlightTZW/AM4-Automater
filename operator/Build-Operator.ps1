#requires -Version 5.1
# Build the operator panel from tracked C# source; never starts the panel or game.
param([string]$OutputPath=(Join-Path $PSScriptRoot 'AM4-Operator.exe'))
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $OutputPath){throw 'Output already exists; choose a new build path. Do not overwrite a running operator panel.'}
Add-Type -Path (Join-Path $PSScriptRoot 'OperatorWindow.cs') -OutputAssembly $OutputPath -OutputType WindowsApplication -ReferencedAssemblies 'System.Windows.Forms','System.Drawing','System.Web.Extensions'
Write-Output ('Built '+$OutputPath)
