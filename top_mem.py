import os

processes = []
for pid in os.listdir("/proc"):
    if pid.isdigit():
        try:
            with open(f"/proc/{pid}/statm") as f:
                parts = f.read().split()
                rss_bytes = int(parts[1]) * 4096
            with open(f"/proc/{pid}/comm") as f:
                comm = f.read().strip()
            # Пытаемся достать полный cmdline для наглядности
            cmdline = comm
            if os.path.exists(f"/proc/{pid}/cmdline"):
                with open(f"/proc/{pid}/cmdline") as cf:
                    c = cf.read().replace('\x00', ' ').strip()
                    if c:
                        cmdline = c
            processes.append((pid, cmdline, rss_bytes))
        except Exception:
            pass

processes.sort(key=lambda x: x[2], reverse=True)
print("PID   | RSS (MB) | COMMAND")
print("-" * 50)
for pid, cmd, rss in processes[:10]:
    print(f"{pid:<5} | {rss/1024/1024:<8.2f} | {cmd[:50]}")
