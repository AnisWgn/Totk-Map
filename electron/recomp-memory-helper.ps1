$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$code = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public sealed class RecompScanner : IDisposable {
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_VM_OPERATION = 0x0008;
    private const uint PROCESS_VM_READ = 0x0010;
    private const uint PROCESS_VM_WRITE = 0x0020;

    private const uint MEM_COMMIT = 0x1000;
    private const uint PAGE_READONLY = 0x02;
    private const uint PAGE_READWRITE = 0x04;
    private const uint PAGE_GUARD = 0x100;

    private const ulong GUEST_MIN = 0x100000000UL;
    private const ulong GUEST_HEAP_MAX = 0x7000000000UL;

    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORY_BASIC_INFORMATION {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public ushort PartitionId;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr VirtualQueryEx(IntPtr hProcess, IntPtr lpAddress, out MEMORY_BASIC_INFORMATION lpBuffer, IntPtr dwLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr baseAddress, byte[] buffer, int size, out IntPtr bytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteProcessMemory(IntPtr hProcess, IntPtr baseAddress, byte[] buffer, int size, out IntPtr bytesWritten);

    private static readonly HashSet<uint> ValidPinTypes = new HashSet<uint> {
        0x7e3d1e46u, // Invalid
        0x6e1a9181u, // Red
        0xe2911abau, // Blue
        0xc03f6678u, // Yellow
        0x7c9b6ddbu, // Green
        0x7f0ae256u, // Purple
        0x01666931u  // LightBlue
    };

    private static readonly HashSet<uint> ValidStampTypes = new HashSet<uint> {
        0x7e3d1e46u, // Invalid
        0xb3005873u, // Sword
        0x9f0d8121u, // Pot
        0x0a8749f6u, // Human
        0x57bd0c79u, // Rhombus
        0xc6aa2e79u, // Heart
        0x55511229u, // Star
        0x0aedde59u, // TreasureBox
        0x3028107du, // Skull
        0x51b0bed0u, // Leaf
        0x8093120eu  // Ore
    };

    private static readonly HashSet<uint> ValidStampLayers = new HashSet<uint> {
        0xb1085c38u, // Sky
        0x24950135u, // Ground
        0xf0235d8du, // Underground
        0u
    };

    public int Pid { get; private set; }
    public string ProcessName { get; private set; }
    public bool CanWrite { get; private set; }

    private IntPtr _handle = IntPtr.Zero;
    private ulong _pinTypeBuf = 0;
    private ulong _pinPosBuf = 0;
    private ulong _stampTypeBuf = 0;
    private ulong _stampLayerBuf = 0;
    private ulong _stampPosBuf = 0;
    private ulong _cameraAddr = 0;
    private ulong _savePosBuf = 0;

    public bool IsAttached() {
        if (_handle == IntPtr.Zero || Pid <= 0) return false;
        try {
            var p = Process.GetProcessById(Pid);
            return !p.HasExited;
        } catch {
            Detach();
            return false;
        }
    }

    public void Detach() {
        if (_handle != IntPtr.Zero) {
            CloseHandle(_handle);
            _handle = IntPtr.Zero;
        }
        Pid = 0;
        ProcessName = "";
        CanWrite = false;
        ResetPointers();
    }

    public void ResetPointers() {
        _pinTypeBuf = 0;
        _pinPosBuf = 0;
        _stampTypeBuf = 0;
        _stampLayerBuf = 0;
        _stampPosBuf = 0;
        _cameraAddr = 0;
        _savePosBuf = 0;
    }

    public bool TryAttach() {
        if (IsAttached()) return true;
        string[] names = new[] { "totk", "TotkRecomp", "totk-recomp", "totk_recomp" };
        foreach (string candidate in names) {
            Process[] procs;
            try { procs = Process.GetProcessesByName(candidate); } catch { continue; }
            foreach (var p in procs) {
                try {
                    if (p.HasExited) continue;
                    IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_VM_OPERATION | PROCESS_VM_WRITE, false, p.Id);
                    bool writable = true;
                    if (h == IntPtr.Zero) {
                        h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, p.Id);
                        writable = false;
                    }
                    if (h != IntPtr.Zero) {
                        _handle = h;
                        Pid = p.Id;
                        ProcessName = p.ProcessName + ".exe";
                        CanWrite = writable;
                        ResetPointers();
                        return true;
                    }
                } catch {}
            }
        }
        return false;
    }

    private bool ReadBytes(ulong addr, byte[] buf, int len) {
        if (_handle == IntPtr.Zero || addr < GUEST_MIN || addr >= GUEST_HEAP_MAX) return false;
        IntPtr read;
        return ReadProcessMemory(_handle, (IntPtr)addr, buf, len, out read) && read.ToInt64() == len;
    }

    private bool IsPageWritable(ulong addr) {
        MEMORY_BASIC_INFORMATION mbi;
        IntPtr res = VirtualQueryEx(_handle, (IntPtr)addr, out mbi, (IntPtr)Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION)));
        if (res == IntPtr.Zero) return false;
        if (mbi.State != MEM_COMMIT) return false;
        if ((mbi.Protect & PAGE_GUARD) != 0) return false;
        return (mbi.Protect & 0xFFu) == PAGE_READWRITE;
    }

    private bool CheckPinTypeBuffer(ulong ptr) {
        byte[] b = new byte[24];
        if (!ReadBytes(ptr, b, 24)) return false;
        for (int i = 0; i < 6; i++) {
            uint v = BitConverter.ToUInt32(b, i * 4);
            if (!ValidPinTypes.Contains(v)) return false;
        }
        return true;
    }

    private bool CheckPinPosBuffer(ulong ptr) {
        byte[] b = new byte[72];
        if (!ReadBytes(ptr, b, 72)) return false;
        for (int i = 0; i < 18; i++) {
            float f = BitConverter.ToSingle(b, i * 4);
            if (float.IsNaN(f) || float.IsInfinity(f) || Math.Abs(f) > 20000f) return false;
        }
        return true;
    }

    private bool CheckStampTypeBuffer(ulong ptr) {
        byte[] b = new byte[1200];
        if (!ReadBytes(ptr, b, 1200)) return false;
        for (int i = 0; i < 300; i++) {
            uint v = BitConverter.ToUInt32(b, i * 4);
            if (!ValidStampTypes.Contains(v)) return false;
        }
        return true;
    }

    private bool CheckStampLayerBuffer(ulong ptr) {
        byte[] b = new byte[1200];
        if (!ReadBytes(ptr, b, 1200)) return false;
        for (int i = 0; i < 300; i++) {
            uint v = BitConverter.ToUInt32(b, i * 4);
            if (!ValidStampLayers.Contains(v)) return false;
        }
        return true;
    }

    private bool CheckStampPosBuffer(ulong ptr) {
        byte[] b = new byte[2400];
        if (!ReadBytes(ptr, b, 2400)) return false;
        for (int i = 0; i < 600; i++) {
            float f = BitConverter.ToSingle(b, i * 4);
            if (float.IsNaN(f) || float.IsInfinity(f) || Math.Abs(f) > 20000f) return false;
        }
        return true;
    }

    private bool CheckCameraAt(byte[] chunk, int off, int chunkLen) {
        // sead camera pose inside camera component (+0xe8 eye[3] double, +0x110 target[3] double, +0x128 up[3] float, +0x134 near/far/fovy/aspect)
        if (off + 0x5c > chunkLen) return false;
        float near = BitConverter.ToSingle(chunk, off + 0x4c);
        float far = BitConverter.ToSingle(chunk, off + 0x50);
        float fovy = BitConverter.ToSingle(chunk, off + 0x54);
        float aspect = BitConverter.ToSingle(chunk, off + 0x58);
        if (!(near >= 0.04f && near <= 2.0f && far >= 500f && far <= 60000f && fovy >= 0.25f && fovy <= 2.2f && aspect >= 1.1f && aspect <= 4.0f)) {
            return false;
        }
        float upX = BitConverter.ToSingle(chunk, off + 0x40);
        float upY = BitConverter.ToSingle(chunk, off + 0x44);
        float upZ = BitConverter.ToSingle(chunk, off + 0x48);
        float upNorm = upX * upX + upY * upY + upZ * upZ;
        if (!(upNorm >= 0.96f && upNorm <= 1.04f && upY >= 0.15f)) return false;

        double ex = BitConverter.ToDouble(chunk, off);
        double ey = BitConverter.ToDouble(chunk, off + 8);
        double ez = BitConverter.ToDouble(chunk, off + 16);
        double tx = BitConverter.ToDouble(chunk, off + 0x28);
        double ty = BitConverter.ToDouble(chunk, off + 0x30);
        double tz = BitConverter.ToDouble(chunk, off + 0x38);
        if (double.IsNaN(ex) || double.IsNaN(ey) || double.IsNaN(ez) || double.IsNaN(tx) || double.IsNaN(ty) || double.IsNaN(tz)) return false;
        if (ex == 0.0 && ey == 0.0 && ez == 10.0 && tx == 0.0 && ty == 0.0 && tz == 0.0) return false;
        if (Math.Abs(tx) > 7500.0 || Math.Abs(tz) > 7500.0 || ty < -1500.0 || ty > 4500.0) return false;

        double dx = tx - ex, dy = ty - ey, dz = tz - ez;
        double dist = Math.Sqrt(dx * dx + dy * dy + dz * dz);
        return dist >= 1.0 && dist <= 60.0;
    }

    private ulong FindSeadBufferNear(byte[] chunk, int hitOffset, int chunkLen, int expectedCount, Func<ulong, bool> validator) {
        int start = Math.Max(0, (hitOffset - 0x90) & ~3);
        int end = Math.Min(chunkLen - 16, hitOffset + 0x90);
        for (int p = start; p <= end; p += 4) {
            int cnt = BitConverter.ToInt32(chunk, p);
            if (cnt != expectedCount) continue;
            ulong ptr = BitConverter.ToUInt64(chunk, p + 8);
            if (ptr >= GUEST_MIN && ptr < GUEST_HEAP_MAX && (ptr & 3UL) == 0 && validator(ptr)) {
                return ptr;
            }
        }
        return 0;
    }

    public void ScanGuestHeap() {
        if (!IsAttached()) return;
        ulong addr = GUEST_MIN;
        int mbiSize = Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION));
        const int CHUNK = 4 * 1024 * 1024;
        byte[] buf = new byte[CHUNK + 256];

        while (addr < GUEST_HEAP_MAX) {
            MEMORY_BASIC_INFORMATION mbi;
            if (VirtualQueryEx(_handle, (IntPtr)addr, out mbi, (IntPtr)mbiSize) == IntPtr.Zero) break;
            ulong regBase = (ulong)mbi.BaseAddress.ToInt64();
            ulong regSize = (ulong)mbi.RegionSize.ToInt64();
            if (regSize == 0) break;

            uint prot = mbi.Protect & 0xFFu;
            bool readable = mbi.State == MEM_COMMIT && (mbi.Protect & PAGE_GUARD) == 0 && (prot == PAGE_READWRITE || prot == PAGE_READONLY);

            if (readable && regBase < GUEST_HEAP_MAX) {
                ulong scanEnd = Math.Min(regBase + regSize, GUEST_HEAP_MAX);
                for (ulong cur = regBase; cur < scanEnd; cur += (ulong)CHUNK) {
                    int toRead = (int)Math.Min((ulong)CHUNK, scanEnd - cur);
                    IntPtr got;
                    if (!ReadProcessMemory(_handle, (IntPtr)cur, buf, toRead, out got) || got.ToInt32() < 64) continue;
                    int n = got.ToInt32();

                    for (int i = 0; i <= n - 8; i += 4) {
                        uint w = BitConverter.ToUInt32(buf, i);
                        if (_pinTypeBuf == 0 && w == 0x1b62aa42u) {
                            _pinTypeBuf = FindSeadBufferNear(buf, i, n, 6, CheckPinTypeBuffer);
                        } else if (_pinPosBuf == 0 && w == 0x5f93e70fu) {
                            _pinPosBuf = FindSeadBufferNear(buf, i, n, 6, CheckPinPosBuffer);
                        } else if (_stampTypeBuf == 0 && w == 0x14d7f4c4u) {
                            _stampTypeBuf = FindSeadBufferNear(buf, i, n, 300, CheckStampTypeBuffer);
                        } else if (_stampLayerBuf == 0 && w == 0xd2025694u) {
                            _stampLayerBuf = FindSeadBufferNear(buf, i, n, 300, CheckStampLayerBuffer);
                        } else if (_stampPosBuf == 0 && w == 0xf24fc2e7u) {
                            _stampPosBuf = FindSeadBufferNear(buf, i, n, 300, CheckStampPosBuffer);
                        } else if (_savePosBuf == 0 && w == 0xc884818du && i + 16 <= n) {
                            ulong p = BitConverter.ToUInt64(buf, i + 8);
                            byte[] pb = new byte[12];
                            if (p >= GUEST_MIN && p < GUEST_HEAP_MAX && ReadBytes(p, pb, 12)) {
                                float sx = BitConverter.ToSingle(pb, 0);
                                float sy = BitConverter.ToSingle(pb, 4);
                                float sz = BitConverter.ToSingle(pb, 8);
                                if (!float.IsNaN(sx) && Math.Abs(sx) <= 7500f && Math.Abs(sz) <= 7500f && (sx != 0f || sz != 0f)) {
                                    _savePosBuf = p;
                                }
                            }
                        }

                        if (_cameraAddr == 0 && (i & 7) == 0 && CheckCameraAt(buf, i, n)) {
                            _cameraAddr = cur + (ulong)i;
                        }
                    }

                    if (_pinTypeBuf != 0 && _pinPosBuf != 0 && _stampTypeBuf != 0 && _stampLayerBuf != 0 && _stampPosBuf != 0 && _cameraAddr != 0) {
                        return;
                    }
                }
            }

            addr = regBase + regSize;
        }
    }

    public bool TryWritePin(int slot, uint typeHash, float x, float y, float z, out string error) {
        error = "";
        if (!IsAttached() || !CanWrite) {
            error = "Process handle is read-only.";
            return false;
        }
        if (slot < 0 || slot > 5 || _pinTypeBuf == 0 || _pinPosBuf == 0) {
            error = "MapPinData pointers are not resolved yet.";
            return false;
        }
        ulong typeAddr = _pinTypeBuf + (ulong)(slot * 4);
        ulong posAddr = _pinPosBuf + (ulong)(slot * 12);
        if (!IsPageWritable(typeAddr) || !IsPageWritable(posAddr)) {
            error = "MapPinData memory page is currently frozen (open the in-game map once to thaw it).";
            return false;
        }
        byte[] tb = BitConverter.GetBytes(typeHash);
        byte[] pb = new byte[12];
        Buffer.BlockCopy(BitConverter.GetBytes(x), 0, pb, 0, 4);
        Buffer.BlockCopy(BitConverter.GetBytes(y), 0, pb, 4, 4);
        Buffer.BlockCopy(BitConverter.GetBytes(z), 0, pb, 8, 4);

        IntPtr w1, w2;
        bool ok1 = WriteProcessMemory(_handle, (IntPtr)typeAddr, tb, 4, out w1) && w1.ToInt32() == 4;
        bool ok2 = WriteProcessMemory(_handle, (IntPtr)posAddr, pb, 12, out w2) && w2.ToInt32() == 12;
        if (!ok1 || !ok2) {
            error = "WriteProcessMemory failed.";
            return false;
        }
        return true;
    }

    private static string F(double v) {
        return v.ToString("0.###", CultureInfo.InvariantCulture);
    }

    public string PollJson() {
        if (!TryAttach()) {
            return "{\"status\":\"searching\"}";
        }
        if (_pinTypeBuf == 0 && _stampTypeBuf == 0 && _cameraAddr == 0) {
            ScanGuestHeap();
        }

        var sb = new StringBuilder(2048);
        sb.Append("{\"status\":\"connected\",\"pid\":").Append(Pid);
        sb.Append(",\"processName\":\"").Append(ProcessName).Append("\"");
        sb.Append(",\"canWriteMemory\":").Append(CanWrite && _pinTypeBuf != 0 && _pinPosBuf != 0 ? "true" : "false");

        // Camera / live player position
        bool hasPos = false;
        if (_cameraAddr != 0) {
            byte[] cb = new byte[0x60];
            if (ReadBytes(_cameraAddr, cb, 0x5c) && CheckCameraAt(cb, 0, 0x5c)) {
                double ex = BitConverter.ToDouble(cb, 0);
                double ey = BitConverter.ToDouble(cb, 8);
                double ez = BitConverter.ToDouble(cb, 16);
                double tx = BitConverter.ToDouble(cb, 0x28);
                double ty = BitConverter.ToDouble(cb, 0x30);
                double tz = BitConverter.ToDouble(cb, 0x38);
                double yaw = Math.Atan2(tx - ex, tz - ez);
                sb.Append(",\"playerPosition\":{\"x\":").Append(F(tx)).Append(",\"y\":").Append(F(ty)).Append(",\"z\":").Append(F(tz)).Append("}");
                sb.Append(",\"playerYaw\":").Append(F(yaw));
                hasPos = true;
            } else {
                _cameraAddr = 0;
            }
        }
        if (!hasPos && _savePosBuf != 0) {
            byte[] pb = new byte[12];
            if (ReadBytes(_savePosBuf, pb, 12)) {
                float sx = BitConverter.ToSingle(pb, 0);
                float sy = BitConverter.ToSingle(pb, 4);
                float sz = BitConverter.ToSingle(pb, 8);
                if (!float.IsNaN(sx) && !float.IsNaN(sy) && !float.IsNaN(sz)) {
                    sb.Append(",\"playerPosition\":{\"x\":").Append(F(sx)).Append(",\"y\":").Append(F(sy)).Append(",\"z\":").Append(F(sz)).Append("}");
                }
            }
        }

        // Colored pins (6 slots)
        if (_pinTypeBuf != 0 && _pinPosBuf != 0) {
            byte[] tb = new byte[24];
            byte[] pb = new byte[72];
            if (ReadBytes(_pinTypeBuf, tb, 24) && ReadBytes(_pinPosBuf, pb, 72)) {
                sb.Append(",\"pinTypes\":[");
                for (int i = 0; i < 6; i++) {
                    if (i > 0) sb.Append(",");
                    sb.Append(BitConverter.ToUInt32(tb, i * 4));
                }
                sb.Append("],\"pinPositions\":[");
                for (int i = 0; i < 6; i++) {
                    if (i > 0) sb.Append(",");
                    float x = BitConverter.ToSingle(pb, i * 12);
                    float y = BitConverter.ToSingle(pb, i * 12 + 4);
                    float z = BitConverter.ToSingle(pb, i * 12 + 8);
                    sb.Append("[").Append(F(x)).Append(",").Append(F(y)).Append(",").Append(F(z)).Append("]");
                }
                sb.Append("]");
            } else {
                _pinTypeBuf = 0;
                _pinPosBuf = 0;
            }
        }

        // Stamps (300 slots — emit only active non-Invalid slots for tiny JSON!)
        if (_stampTypeBuf != 0 && _stampLayerBuf != 0 && _stampPosBuf != 0) {
            byte[] tb = new byte[1200];
            byte[] lb = new byte[1200];
            byte[] pb = new byte[2400];
            if (ReadBytes(_stampTypeBuf, tb, 1200) && ReadBytes(_stampLayerBuf, lb, 1200) && ReadBytes(_stampPosBuf, pb, 2400)) {
                sb.Append(",\"activeStamps\":[");
                bool first = true;
                for (int i = 0; i < 300; i++) {
                    uint t = BitConverter.ToUInt32(tb, i * 4);
                    if (t == 0x7e3d1e46u || t == 0u) continue;
                    uint l = BitConverter.ToUInt32(lb, i * 4);
                    float x = BitConverter.ToSingle(pb, i * 8);
                    float north = BitConverter.ToSingle(pb, i * 8 + 4);
                    if (!first) sb.Append(",");
                    first = false;
                    sb.Append("[").Append(i).Append(",").Append(t).Append(",").Append(l).Append(",").Append(F(x)).Append(",").Append(F(north)).Append("]");
                }
                sb.Append("]");
            } else {
                _stampTypeBuf = 0;
                _stampLayerBuf = 0;
                _stampPosBuf = 0;
            }
        }

        sb.Append("}");
        return sb.ToString();
    }

    public void Dispose() {
        Detach();
    }
}
'@

Add-Type -TypeDefinition $code -Language CSharp

$scanner = New-Object RecompScanner
$readTask = [Console]::In.ReadLineAsync()
$lastJson = ""
$lastEmitMs = 0

try {
    while ($true) {
        if ($readTask.IsCompleted) {
            $line = $readTask.Result
            if ($null -eq $line) { break }
            $readTask = [Console]::In.ReadLineAsync()
            if ($line.Trim().Length -gt 0) {
                try {
                    $msg = $line | ConvertFrom-Json
                    if ($msg.cmd -eq 'quit') { break }
                    elseif ($msg.cmd -eq 'rescan') {
                        $scanner.ResetPointers()
                        $scanner.ScanGuestHeap()
                        $lastJson = ""
                    }
                    elseif ($msg.cmd -eq 'setPin') {
                        $err = ""
                        $ok = $scanner.TryWritePin([int]$msg.slot, [uint32]$msg.typeHash, [single]$msg.x, [single]$msg.y, [single]$msg.z, [ref]$err)
                        $resp = @{ reply = 'setPin'; id = $msg.id; ok = $ok; error = $err } | ConvertTo-Json -Compress
                        [Console]::Out.WriteLine($resp)
                        [Console]::Out.Flush()
                        $lastJson = ""
                    }
                } catch {}
            }
        }

        $json = $scanner.PollJson()
        $nowMs = [Environment]::TickCount64
        if ($json -ne $lastJson -or ($nowMs - $lastEmitMs) -ge 2000) {
            [Console]::Out.WriteLine($json)
            [Console]::Out.Flush()
            $lastJson = $json
            $lastEmitMs = $nowMs
        }

        Start-Sleep -Milliseconds 220
    }
} finally {
    $scanner.Dispose()
}
