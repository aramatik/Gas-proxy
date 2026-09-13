import urllib.request
import time
import subprocess
import re
import statistics

url = "https://proof.ovh.net/files/100Mb.dat"
host = "proof.ovh.net"

print("=" * 44)
print("               ---SPEEDTEST---")
print("=" * 44)

# 1. Измерение Ping и Jitter
try:
    count = 10
    proc = subprocess.run(["ping", "-c", str(count), "-W", "2", host], capture_output=True, text=True, timeout=15)
    latencies = [float(x) for x in re.findall(r"time=([\d\.]+)\s*ms", proc.stdout)]
    
    if latencies:
        avg_ping = statistics.mean(latencies)
        min_ping = min(latencies)
        max_ping = max(latencies)
        
        # Расчет джиттера как среднего абсолютного отклонения между последовательными пингами
        if len(latencies) > 1:
            diffs = [abs(latencies[i] - latencies[i-1]) for i in range(1, len(latencies))]
            jitter = statistics.mean(diffs)
        else:
            jitter = 0.0
            
        print(f"• Ping: {avg_ping:.2f} мс")
        print(f"• Jitter: {jitter:.2f} мс")
    else:
        print("  • Не удалось получить данные пинга из вывода команды.")
except Exception as e:
    print(f"  • Ошибка при измерении пинга/джиттера: {e}")

print("-" * 44)

# 2. Измерение скорости скачивания (Download)
print(f"Скачивание файла {url}...")
start_time = time.time()
try:
    req = urllib.request.urlopen(url, timeout=30)
    chunk_size = 8192
    downloaded = 0
    while True:
        chunk = req.read(chunk_size)
        if not chunk:
            break
        downloaded += len(chunk)
    
    elapsed = time.time() - start_time
    speed_bps = (downloaded * 8) / elapsed
    speed_mbps = speed_bps / (1024 * 1024)
    
    print(f"Успешно скачано: {downloaded / (1024*1024):.2f} МБ")
    print(f"Затрачено времени: {elapsed:.2f} сек.")
    print(f"Скорость загрузки (Download): {speed_mbps:.2f} Мбит/с")
except Exception as e:
    print(f"Ошибка при проверке скорости: {e}")

print("=" * 44)
