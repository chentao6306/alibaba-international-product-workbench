using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

// A managed entry point runs before NSIS extracts any plugins into TEMP.
// It changes only the child process environment, never Windows/user settings.
internal static class SetupBootstrap
{
    const string RegistryPath = @"Software\8428415b-1332-5db5-ad0a-ee314d165ad4";
    const long MiB = 1024 * 1024;
    static string logPath;
    static bool quiet;
    static bool helperMode;
    static string work;
    static string self = Assembly.GetExecutingAssembly().Location;
    static List<string[]> manifest = new List<string[]>();
    static string updateResult;
    static string recoveryRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "chaodekuai-update-recovery");
    static string recoveryTarget;
    static bool replacing;
    static System.Threading.Mutex installMutex;

    [STAThread]
    static int Main(string[] args)
    {
        quiet = Array.Exists(args, a => a.Equals("/S", StringComparison.OrdinalIgnoreCase));
        try
        {
            LoadManifest();
            helperMode = args.Length > 0 && (args[0] == "/preflight" || args[0] == "/verify");
            logPath = helperMode ? Environment.GetEnvironmentVariable("CHAODEKUAI_SETUP_LOG") : CreateLog();
            if (helperMode)
            {
                if (args.Length != 3) throw new ArgumentException("安装检查参数不完整。");
                if (args[0] == "/preflight") CheckSpace(args[1], args[2], true);
                else
                {
                    VerifyFiles(args[1]);
                    File.WriteAllText(Path.Combine(args[2], "verified-install.txt"), Path.GetFullPath(args[1]), Encoding.UTF8);
                }
                return 0;
            }
            bool created;
            installMutex = new System.Threading.Mutex(true, "Local\\ChaodekuaiSetupRecovery", out created);
            if (!created) return Fail(1618, "已有安装程序正在运行，请等待其结束后重试。");
            Log("start version=" + SetupMetadata.Version);
            string target = FindInstallDirectory();
            string journal = Path.Combine(recoveryRoot, "pending.txt");
            if (File.Exists(journal)) target = File.ReadAllText(journal, Encoding.UTF8).Trim();
            foreach (string arg in args)
                if (arg.StartsWith("/D=", StringComparison.OrdinalIgnoreCase)) target = arg.Substring(3);
            string parentArg = Array.Find(args, a => a.StartsWith("/update-parent=", StringComparison.OrdinalIgnoreCase));
            bool updating = parentArg != null;
            if (updating)
            {
                string readyArg = Array.Find(args, a => a.StartsWith("/update-ready=", StringComparison.OrdinalIgnoreCase));
                string resultArg = Array.Find(args, a => a.StartsWith("/update-result=", StringComparison.OrdinalIgnoreCase));
                if (readyArg == null || resultArg == null) throw new ArgumentException("更新交接参数不完整。");
                updateResult = resultArg.Substring("/update-result=".Length);
                int parentId;
                if (!Int32.TryParse(parentArg.Substring("/update-parent=".Length), out parentId) || parentId <= 0) throw new ArgumentException("更新进程编号无效。");
                using (Process parent = Process.GetProcessById(parentId))
                {
                    if (!Path.GetFullPath(parent.MainModule.FileName).Equals(Path.GetFullPath(Path.Combine(target, "抄得快.exe")), StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("更新目标与当前软件安装位置不一致。");
                    // Fail protected-directory updates while the workbench is
                    // still open. NSIS may elevate later, but the bootstrap's
                    // backup/restore runs before NSIS and needs this access.
                    CheckTargetWritable(target);
                    work = SelectWorkDirectory(target);
                    File.WriteAllText(readyArg.Substring("/update-ready=".Length), "ready", Encoding.UTF8);
                    Log("waiting-for-parent=" + parentId);
                    if (!parent.WaitForExit(120000)) return Fail(1618, "软件尚未完成保存退出，本次未安装，请稍后重试。");
                }
            }
            string selected = SelectWorkDirectory(target);
            if (updating && work != null) CleanupWork();
            work = selected;
            Log("temporary-directory=" + work + " target=" + target);
            if (Array.Exists(args, a => a.Equals("/checkonly", StringComparison.OrdinalIgnoreCase)))
            {
                Log("preflight-only=passed");
                CleanupWork();
                return 0;
            }
            if (Process.GetProcessesByName("抄得快").Length != 0)
                return Fail(1618, "抄得快 仍在运行。请在软件中退出并等待数据保存完成，再重新运行安装包。");
            CheckProgramReplaceable(target, 10000);
            RecoverInterruptedUpdate();
            if (updating) BackupProgram(target);
            string inner = Path.Combine(work, "chaodekuai-inner.exe");
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("installer.exe"))
            using (FileStream output = new FileStream(inner, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                if (resource == null) throw new InvalidDataException("安装包缺少程序文件。");
                resource.CopyTo(output);
                output.Flush(true);
            }
            if (!Hash(inner).Equals(SetupMetadata.InstallerSha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("安装文件校验失败，尚未更改旧版程序。请重新获取安装包。");
            var arguments = new List<string>();
            string directoryArgument = null;
            foreach (string arg in args)
            {
                if (arg.StartsWith("/D=", StringComparison.OrdinalIgnoreCase)) directoryArgument = arg;
                else if (arg.StartsWith("/update-", StringComparison.OrdinalIgnoreCase) || arg.Equals("/restart", StringComparison.OrdinalIgnoreCase)) continue;
                else arguments.Add(Quote(arg));
            }
            // NSIS requires /D to be last and unquoted, including paths with spaces.
            if (directoryArgument != null) arguments.Add(directoryArgument);
            var start = new ProcessStartInfo(inner, String.Join(" ", arguments.ToArray()));
            start.UseShellExecute = false;
            start.WorkingDirectory = work;
            start.EnvironmentVariables["TEMP"] = work;
            start.EnvironmentVariables["TMP"] = work;
            start.EnvironmentVariables["CHAODEKUAI_SETUP_BOOTSTRAP"] = self;
            start.EnvironmentVariables["CHAODEKUAI_SETUP_LOG"] = logPath;
            start.EnvironmentVariables["CHAODEKUAI_SETUP_WORK"] = work;
            start.EnvironmentVariables["CHAODEKUAI_SETUP_QUIET"] = quiet ? "1" : "0";
            int code;
            replacing = updating;
            using (Process child = Process.Start(start)) { child.WaitForExit(); code = child.ExitCode; }
            Log("installer-exit=" + code);
            string receipt = Path.Combine(work, "verified-install.txt");
            if (code != 0)
            {
                string reason = "安装未完成，返回码：" + code + "。请查看安装日志中的具体原因。";
                foreach (string line in File.ReadAllLines(logPath, Encoding.UTF8))
                    if (line.Contains("error code=")) reason = line.Substring(line.IndexOf("error code=", StringComparison.Ordinal));
                return Fail(code, reason);
            }
            if (!File.Exists(receipt))
                return Fail(1603, "未收到安装完整性校验结果，不能确认安装成功。请查看日志后重试。");
            string installed = File.ReadAllText(receipt, Encoding.UTF8).Trim();
            VerifyFiles(installed);
            replacing = false;
            CompleteRecovery();
            Log("complete version=" + SetupMetadata.Version + " directory=" + installed);
            CleanupWork();
            if (updating)
            {
                WriteUpdateResult(0, "安装完成");
                if (Array.Exists(args, a => a.Equals("/restart", StringComparison.OrdinalIgnoreCase)))
                {
                    var restart = new ProcessStartInfo(Path.Combine(installed, "抄得快.exe"));
                    restart.UseShellExecute = false;
                    restart.WorkingDirectory = installed;
                    Process.Start(restart);
                }
            }
            return 0;
        }
        catch (Exception ex) { return Fail(1603, ex.Message); }
    }

    static string CreateLog()
    {
        foreach (string parent in new[] { Path.GetDirectoryName(self), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
        {
            try
            {
                string directory = Path.Combine(parent, "chaodekuai-install-logs");
                Directory.CreateDirectory(directory);
                string file = Path.Combine(directory, "setup-" + SetupMetadata.Version + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".log");
                File.WriteAllText(file, "", Encoding.UTF8);
                return file;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        throw new IOException("无法创建安装日志，请把安装包放到可写目录后重试。");
    }

    static void Log(string message)
    {
        if (!String.IsNullOrEmpty(logPath)) File.AppendAllText(logPath, DateTime.Now.ToString("O") + " " + message + Environment.NewLine, Encoding.UTF8);
    }

    static int Fail(int code, string reason)
    {
        if (replacing)
        {
            try { RecoverInterruptedUpdate(); reason += "\n旧版程序已恢复，可以重新运行此安装包。"; }
            catch (Exception ex) { reason += "\n恢复副本已保留，请重新运行此安装包完成恢复：" + ex.Message; }
            replacing = false;
        }
        WriteUpdateResult(code, reason);
        try { Log("error code=" + code + " " + reason); } catch { }
        bool helperQuiet = Environment.GetEnvironmentVariable("CHAODEKUAI_SETUP_QUIET") == "1";
        if ((!quiet || updateResult != null) && !helperQuiet && !helperMode) MessageBox.Show(reason + "\n\n日志：" + (logPath ?? "未创建") + "\n安装检查不会删除采集数据或账号登录信息。", "抄得快 安装未完成", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return code;
    }

    static void WriteUpdateResult(int code, string message)
    {
        if (updateResult == null) return;
        try { File.WriteAllText(updateResult, SetupMetadata.Version + "\n" + code + "\n" + message + "\n" + logPath, Encoding.UTF8); } catch { }
    }

    static string FindInstallDirectory()
    {
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using (RegistryKey root = Microsoft.Win32.RegistryKey.OpenBaseKey(hive, view))
            using (RegistryKey key = root.OpenSubKey(RegistryPath))
            {
                string value = key == null ? null : key.GetValue("InstallLocation") as string;
                if (!String.IsNullOrWhiteSpace(value)) return Path.GetFullPath(value);
            }
        }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "抄得快");
    }

    static string SelectWorkDirectory(string target)
    {
        var parents = new List<string>();
        // Prefer space on the installation package drive instead of assuming C: has room.
        parents.Add(Path.Combine(Path.GetDirectoryName(self), "chaodekuai-install-work"));
        parents.Add(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(target)), "chaodekuai-install-work"));
        parents.Add(Path.Combine(Path.GetTempPath(), "chaodekuai-install-work"));
        foreach (DriveInfo drive in DriveInfo.GetDrives())
            if (drive.IsReady && drive.DriveType == DriveType.Fixed)
                parents.Add(Path.Combine(drive.RootDirectory.FullName, "chaodekuai-install-work"));
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var errors = new List<string>();
        foreach (string parent in parents)
        {
            string candidate = null;
            try
            {
                string full = Path.GetFullPath(parent);
                if (!seen.Add(full)) continue;
                candidate = Path.Combine(full, "setup-" + Guid.NewGuid().ToString("N"));
                CheckSpace(target, candidate, false);
                Directory.CreateDirectory(candidate);
                WriteProbe(candidate);
                return candidate;
            }
            catch (Exception ex)
            {
                errors.Add(parent + ": " + ex.Message);
                Log("temporary-rejected " + parent + " " + ex.Message);
                // Only remove the newly created, empty candidate directory.
                try { if (candidate != null && Directory.Exists(candidate)) Directory.Delete(candidate, false); } catch { }
            }
        }
        throw new IOException("没有找到空间足够且可写的安装临时目录。尚未卸载旧版程序。\n" + String.Join("\n", errors.ToArray()));
    }

    static void AddBudget(Dictionary<string, long> budgets, string path, long amount)
    {
        string root = Path.GetPathRoot(Path.GetFullPath(path));
        if (!budgets.ContainsKey(root)) budgets[root] = 0;
        budgets[root] += amount;
    }

    static void CheckSpace(string target, string temporary, bool writeTarget)
    {
        string fullTarget = Path.GetFullPath(target);
        if (String.Equals(fullTarget.TrimEnd('\\'), Path.GetPathRoot(fullTarget).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new IOException("请选择专用的 抄得快 文件夹，不能直接安装到磁盘根目录。");
        var budgets = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        // New extraction + old-version staging + inner installer + extraction archive.
        AddBudget(budgets, temporary, SetupMetadata.PayloadBytes * 2 + SetupMetadata.InstallerBytes * 2 + 256 * MiB);
        AddBudget(budgets, fullTarget, SetupMetadata.PayloadBytes + 128 * MiB);
        AddBudget(budgets, Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), SetupMetadata.InstallerBytes + 128 * MiB);
        // Online updates keep the entire previous program outside its install
        // directory until all new files have been verified. Business data lives
        // in the separate Electron userData directory and is never removed.
        if (updateResult != null && Directory.Exists(fullTarget))
            AddBudget(budgets, recoveryRoot, TreeBytes(new DirectoryInfo(fullTarget)) + 128 * MiB);
        foreach (var entry in budgets)
        {
            var disk = new DriveInfo(entry.Key);
            long free = disk.AvailableFreeSpace;
            if (free < entry.Value)
                throw new IOException(entry.Key + " 可用 " + (free / MiB) + " MB，安装至少需要 " + ((entry.Value + MiB - 1) / MiB) + " MB。请释放空间或更换目录。");
        }
        if (writeTarget)
        {
            CheckTargetWritable(fullTarget);
            CheckProgramReplaceable(fullTarget, 10000);
            WriteProbe(temporary);
            Log("preflight-passed target=" + fullTarget + " temporary=" + temporary);
        }
    }

    static void WriteProbe(string directory)
    {
        string probe = Path.Combine(directory, "chaodekuai-write-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using (var stream = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            { byte[] block = new byte[1024 * 1024]; stream.Write(block, 0, block.Length); stream.Flush(true); }
        }
        finally { if (File.Exists(probe)) File.Delete(probe); }
    }

    static void CheckTargetWritable(string target)
    {
        try
        {
            Directory.CreateDirectory(target);
            WriteProbe(target);
        }
        catch (UnauthorizedAccessException ex)
        {
            throw new UnauthorizedAccessException("安装目录没有写入权限：" + Path.GetFullPath(target)
                + "。本次尚未替换程序文件。请退出软件后，右键完整安装包选择“以管理员身份运行”，并由您确认 Windows 权限提示；无需删除商品数据或修改文件夹权限。", ex);
        }
    }

    static void ProbeProgramFiles(DirectoryInfo directory)
    {
        if ((directory.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("安装目录包含重定向路径，已停止替换。");
        foreach (FileInfo file in directory.GetFiles())
        {
            if ((file.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("程序文件包含重定向路径，已停止替换：" + file.Name);
            if ((file.Attributes & FileAttributes.ReadOnly) != 0)
                throw new UnauthorizedAccessException("程序文件为只读，尚未替换旧版程序：" + file.FullName + "。请检查该文件权限后重试；安装器不会自动改变权限。");
            // Opening an existing file neither truncates nor changes bytes.
            // Check every file before replacing the first one, including PAK
            // resources held by a lingering renderer or another process.
            using (var stream = new FileStream(file.FullName, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
        }
        foreach (DirectoryInfo child in directory.GetDirectories()) ProbeProgramFiles(child);
    }

    static void CheckProgramReplaceable(string target, int timeoutMs)
    {
        if (!Directory.Exists(target)) return;
        CheckTargetWritable(target);
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (true)
        {
            try { ProbeProgramFiles(new DirectoryInfo(target)); return; }
            catch (UnauthorizedAccessException ex)
            {
                throw new UnauthorizedAccessException("程序文件访问被拒绝，尚未开始替换：" + ex.Message
                    + "。请退出软件后以管理员身份运行完整安装包；恢复副本仍保留，不要清理商品数据。", ex);
            }
            catch (IOException ex)
            {
                int code = System.Runtime.InteropServices.Marshal.GetHRForException(ex) & 0xffff;
                if (code != 32 && code != 33) throw;
                if (DateTime.UtcNow >= deadline)
                    throw new IOException("程序文件仍被占用，尚未开始替换：" + ex.Message
                        + "。请正常退出抄得快及相关窗口后重试；安装器不会强制终止进程。", ex);
                System.Threading.Thread.Sleep(200);
            }
        }
    }

    static long TreeBytes(DirectoryInfo directory)
    {
        if ((directory.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("安装目录包含重定向路径，请使用手动安装。");
        long bytes = 0;
        foreach (FileInfo file in directory.GetFiles()) bytes += file.Length;
        foreach (DirectoryInfo child in directory.GetDirectories()) bytes += TreeBytes(child);
        return bytes;
    }

    static void CopyTree(string source, string destination)
    {
        var directory = new DirectoryInfo(source);
        if ((directory.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("恢复目录包含重定向路径。");
        Directory.CreateDirectory(destination);
        foreach (FileInfo file in directory.GetFiles())
        {
            if ((file.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("程序文件包含重定向路径。");
            string output = Path.Combine(destination, file.Name);
            using (var input = file.OpenRead())
            using (var stream = new FileStream(output, FileMode.Create, FileAccess.Write, FileShare.None))
            { input.CopyTo(stream); stream.Flush(true); }
            if (Hash(output) != Hash(file.FullName)) throw new IOException("恢复副本校验失败：" + file.Name);
        }
        foreach (DirectoryInfo child in directory.GetDirectories()) CopyTree(child.FullName, Path.Combine(destination, child.Name));
    }

    static void BackupProgram(string target)
    {
        target = Path.GetFullPath(target);
        if (!File.Exists(Path.Combine(target, "抄得快.exe")) || !File.Exists(Path.Combine(target, "resources", "app.asar")))
            throw new IOException("更新目标不是完整的抄得快安装目录，请重新下载安装包修复。");
        Directory.CreateDirectory(recoveryRoot);
        string backup = Path.Combine(recoveryRoot, "program");
        if (Directory.Exists(backup)) DeleteOwnTree(new DirectoryInfo(backup));
        CopyTree(target, backup);
        string temporary = Path.Combine(recoveryRoot, "pending.tmp");
        using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        { byte[] bytes = Encoding.UTF8.GetBytes(target); stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
        File.Move(temporary, Path.Combine(recoveryRoot, "pending.txt"));
        recoveryTarget = target;
        Log("recovery-copy-verified target=" + target);
    }

    static void RecoverInterruptedUpdate()
    {
        string journal = Path.Combine(recoveryRoot, "pending.txt");
        if (!File.Exists(journal)) return;
        string target = Path.GetFullPath(File.ReadAllText(journal, Encoding.UTF8).Trim());
        if (target.TrimEnd('\\').Equals(Path.GetPathRoot(target).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new IOException("恢复目标无效。");
        if (Process.GetProcessesByName("抄得快").Length != 0) throw new IOException("请先退出抄得快再恢复安装。");
        string backup = Path.Combine(recoveryRoot, "program");
        if (!File.Exists(Path.Combine(backup, "抄得快.exe")) || !File.Exists(Path.Combine(backup, "resources", "app.asar"))) throw new IOException("恢复副本不完整，已保留以供修复。");
        // Check the whole target before CopyTree overwrites its first file.
        // On denied access or locks, leave both the journal and backup intact.
        CheckProgramReplaceable(target, 10000);
        CopyTree(backup, target);
        Log("previous-program-restored target=" + target);
        // Only mark recovery complete after every original file was restored.
        File.Delete(journal);
        recoveryTarget = target;
    }

    static void CompleteRecovery()
    {
        if (recoveryTarget == null) return;
        string journal = Path.Combine(recoveryRoot, "pending.txt");
        if (File.Exists(journal)) File.Delete(journal);
        string backup = Path.Combine(recoveryRoot, "program");
        try { if (Directory.Exists(backup)) DeleteOwnTree(new DirectoryInfo(backup)); }
        catch (Exception ex) { Log("recovery-cleanup-deferred " + ex.Message); }
    }

    static void LoadManifest()
    {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.manifest"))
        using (var reader = new StreamReader(stream, Encoding.UTF8))
        {
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                string[] fields = line.Split('\t');
                if (fields.Length != 3) throw new InvalidDataException("安装校验清单损坏。");
                manifest.Add(fields);
            }
        }
        if (manifest.Count == 0) throw new InvalidDataException("安装校验清单为空。");
    }

    static void VerifyFiles(string directory)
    {
        string root = Path.GetFullPath(directory).TrimEnd('\\') + "\\";
        foreach (string[] fields in manifest)
        {
            string file = Path.GetFullPath(Path.Combine(root, fields[2]));
            if (!file.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装校验路径无效。");
            if (!File.Exists(file) || new FileInfo(file).Length != Int64.Parse(fields[1]) || !Hash(file).Equals(fields[0], StringComparison.OrdinalIgnoreCase))
                throw new IOException("程序文件不完整或内容不符：" + fields[2] + "。请检查磁盘空间后重新安装；本地业务数据没有被清除。");
        }
        Log("payload-verified files=" + manifest.Count + " directory=" + directory);
    }

    static string Hash(string file)
    {
        using (var sha = SHA256.Create())
        using (var input = File.OpenRead(file))
            return BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
    }

    static void CleanupWork()
    {
        if (String.IsNullOrEmpty(work)) return;
        string full = Path.GetFullPath(work);
        // Never recurse outside our unique child folder; reject junctions/symlinks.
        if (!Path.GetFileName(full).StartsWith("setup-", StringComparison.Ordinal) || Path.GetFileName(Path.GetDirectoryName(full)) != "chaodekuai-install-work")
            throw new IOException("临时目录路径检查未通过。");
        try { DeleteOwnTree(new DirectoryInfo(full)); }
        catch (Exception ex) { Log("cleanup-deferred " + ex.Message); }
    }

    static void DeleteOwnTree(DirectoryInfo directory)
    {
        if ((directory.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("临时目录包含重定向路径，保留待检查。");
        foreach (FileInfo file in directory.GetFiles()) file.Delete();
        foreach (DirectoryInfo child in directory.GetDirectories()) DeleteOwnTree(child);
        directory.Delete();
    }

    static string Quote(string argument)
    {
        // NSIS parses /S and /currentuser literally; quoting a bare switch hides it.
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '"' }) < 0) return argument;
        var b = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in argument)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') { b.Append('\\', backslashes * 2 + 1); b.Append(c); }
            else { b.Append('\\', backslashes); b.Append(c); }
            backslashes = 0;
        }
        b.Append('\\', backslashes * 2); b.Append('"'); return b.ToString();
    }
}
