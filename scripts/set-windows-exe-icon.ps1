param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$Icon
)

$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class WeChatBotExeIcon
{
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
    [DllImport("kernel32.dll", SetLastError=true, EntryPoint="UpdateResourceW")]
    static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool EndUpdateResource(IntPtr update, bool discard);

    public static void Set(string executable, string iconFile)
    {
        byte[] ico = File.ReadAllBytes(iconFile);
        if (ico.Length < 6 || BitConverter.ToUInt16(ico,0) != 0 || BitConverter.ToUInt16(ico,2) != 1)
            throw new InvalidDataException("Invalid ICO header.");
        int count = BitConverter.ToUInt16(ico,4);
        if (count < 1 || ico.Length < 6 + 16 * count) throw new InvalidDataException("Invalid ICO directory.");
        byte[] group = new byte[6 + 14 * count];
        Buffer.BlockCopy(ico,0,group,0,6);
        IntPtr handle = BeginUpdateResource(executable,false);
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open executable resources.");
        bool committed = false;
        try
        {
            for (int i=0;i<count;i++)
            {
                int src=6+16*i, dst=6+14*i;
                int bytes=checked((int)BitConverter.ToUInt32(ico,src+8));
                int offset=checked((int)BitConverter.ToUInt32(ico,src+12));
                if (offset < 0 || bytes < 1 || offset + bytes > ico.Length) throw new InvalidDataException("ICO image data is out of bounds.");
                int resourceId=5000+i;
                byte[] image=new byte[bytes]; Buffer.BlockCopy(ico,offset,image,0,bytes);
                if (!UpdateResource(handle,new IntPtr(3),new IntPtr(resourceId),0,image,(uint)image.Length))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not write icon image resource.");
                Buffer.BlockCopy(ico,src,group,dst,12);
                Buffer.BlockCopy(BitConverter.GetBytes((ushort)resourceId),0,group,dst+12,2);
            }
            if (!UpdateResource(handle,new IntPtr(14),new IntPtr(1),0,group,(uint)group.Length))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not write the executable icon group.");
            if (!EndUpdateResource(handle,false)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not save executable icon resources.");
            committed=true;
        }
        finally { if (!committed) EndUpdateResource(handle,true); }
    }
}
'@
if (-not ('WeChatBotExeIcon' -as [type])) { Add-Type -TypeDefinition $code -Language CSharp }
$exePath = (Resolve-Path -LiteralPath $Executable).Path
$icoPath = (Resolve-Path -LiteralPath $Icon).Path
[WeChatBotExeIcon]::Set($exePath,$icoPath)
Write-Output "Updated executable icon: $exePath"
