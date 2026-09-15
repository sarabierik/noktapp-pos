'use strict';
/**
 * Getting the bytes to the printer.
 *  - network : straight TCP to port 9100 (every Epson/Star/Bixolon LAN printer)
 *  - share   : a Windows shared printer, written raw through the spooler
 *  - usb     : a Windows driver-installed printer, written raw through the spooler
 *  - file    : write to a file (used by the test mode and by support)
 * No native modules, so the installer stays a plain download-and-run.
 */
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const log = require('../logger');

function toNetwork(host, port, data, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (err) => { if (!done) { done = true; sock.destroy(); err ? reject(err) : resolve(true); } };
    sock.setTimeout(timeout);
    sock.on('timeout', () => finish(new Error('Yazici yanit vermedi (' + host + ':' + port + ')')));
    sock.on('error', finish);
    sock.connect(port || 9100, host, () => sock.write(data, () => setTimeout(() => finish(null), 250)));
  });
}

/** Raw print through the Windows spooler using an inline C# helper. */
function toWindowsPrinter(printerName, data) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Windows disinda spooler kullanilamaz'));
    const tmp = path.join(os.tmpdir(), 'np_' + Date.now() + '.prn');
    fs.writeFileSync(tmp, data);
    const ps = `
$ErrorActionPreference='Stop'
$src = @"
using System;using System.IO;using System.Runtime.InteropServices;
public class RawPrinter{
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
 public class DOCINFO{[MarshalAs(UnmanagedType.LPWStr)]public string pDocName;[MarshalAs(UnmanagedType.LPWStr)]public string pOutputFile;[MarshalAs(UnmanagedType.LPWStr)]public string pDataType;}
 [DllImport("winspool.Drv",EntryPoint="OpenPrinterW",SetLastError=true,CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string src,out IntPtr h,IntPtr pd);
 [DllImport("winspool.Drv",EntryPoint="ClosePrinter")] public static extern bool ClosePrinter(IntPtr h);
 [DllImport("winspool.Drv",EntryPoint="StartDocPrinterW",SetLastError=true,CharSet=CharSet.Unicode)] public static extern bool StartDocPrinter(IntPtr h,int level,[In,MarshalAs(UnmanagedType.LPStruct)]DOCINFO di);
 [DllImport("winspool.Drv",EntryPoint="EndDocPrinter")] public static extern bool EndDocPrinter(IntPtr h);
 [DllImport("winspool.Drv",EntryPoint="StartPagePrinter")] public static extern bool StartPagePrinter(IntPtr h);
 [DllImport("winspool.Drv",EntryPoint="EndPagePrinter")] public static extern bool EndPagePrinter(IntPtr h);
 [DllImport("winspool.Drv",EntryPoint="WritePrinter")] public static extern bool WritePrinter(IntPtr h,IntPtr buf,int n,out int written);
 public static bool SendFile(string printer,string file){
  byte[] bytes=File.ReadAllBytes(file); IntPtr h; int w;
  if(!OpenPrinter(printer.Normalize(),out h,IntPtr.Zero)) return false;
  DOCINFO di=new DOCINFO(); di.pDocName="NoktApp POS"; di.pDataType="RAW";
  bool ok=StartDocPrinter(h,1,di); if(ok){ StartPagePrinter(h);
   IntPtr p=Marshal.AllocCoTaskMem(bytes.Length); Marshal.Copy(bytes,0,p,bytes.Length);
   ok=WritePrinter(h,p,bytes.Length,out w); Marshal.FreeCoTaskMem(p);
   EndPagePrinter(h); EndDocPrinter(h);} ClosePrinter(h); return ok; }}
"@
Add-Type -TypeDefinition $src -Language CSharp
[RawPrinter]::SendFile("${String(printerName).replace(/"/g, '')}","${tmp.replace(/\\/g, '\\\\')}")`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 20000 }, (err, stdout) => {
        try { fs.unlinkSync(tmp); } catch (_) {}
        if (err) return reject(new Error('Windows yazici hatasi: ' + err.message));
        if (String(stdout).trim().toLowerCase().includes('false')) return reject(new Error('Yazici isi reddetti: ' + printerName));
        resolve(true);
      });
  });
}

async function send(printer, data) {
  const type = (printer.type || 'network').toLowerCase();
  if (type === 'network' || type === 'ip') {
    const [host, port] = String(printer.ip_address || '').split(':');
    return toNetwork(host, Number(port || 9100), data);
  }
  if (type === 'file') {
    const p = printer.ip_address || path.join(os.tmpdir(), 'noktapp-print.txt');
    fs.appendFileSync(p, data);
    return true;
  }
  // share / usb / windows
  return toWindowsPrinter(printer.ip_address || printer.name, data);
}

/** List the printers Windows knows about, so the settings screen can offer them. */
function listWindowsPrinters() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    execFile('powershell.exe',
      ['-NoProfile', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'],
      { windowsHide: true, timeout: 15000 }, (err, stdout) => {
        if (err) { log.warn('print', 'printer list failed', err.message); return resolve([]); }
        resolve(String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean));
      });
  });
}

module.exports = { send, toNetwork, toWindowsPrinter, listWindowsPrinters };
