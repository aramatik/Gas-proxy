#!/bin/sh
echo "====== Анализ системных ресурсов ======"
echo "Лимиты контейнера: 0.2 CPU и 512 MB RAM"
echo ""

read l1 l5 l15 rest < /proc/loadavg

cpu_stats=$(awk -v l1="$l1" -v l5="$l5" -v l15="$l15" 'BEGIN {
    c1 = (l1 / 0.2) * 100
    c5 = (l5 / 0.2) * 100
    c15 = (l15 / 0.2) * 100
    printf "%.1f %.1f %.1f %.1f %.1f %.1f\n", l1*100, l5*100, l15*100, c1, c5, c15
}')

set -- $cpu_stats
raw1=$1; raw5=$2; raw15=$3
pct1=$4; pct5=$5; pct15=$6

# В Kubernetes/cgroupsv2 (Northflank) дашборды часто учитывают memory.current вместе с кэшем (file / swap / slab) 
# или берут сумму anon + file (memory.current показывает именно общую физическую память).
# Однако дашборды хостингов (включая Northflank, Docker Stats) нередко считают usage как (memory.current) или суммируют все выделенные страницы, 
# либо провайдер добавляет системный оверхед контейнера. Давайте выведем детализированно.

if [ -f /sys/fs/cgroup/memory.current ]; then
    ram_current=$(cat /sys/fs/cgroup/memory.current)
    # Посмотрим также memory.stat для полноты картины
    anon=$(awk '/^anon / {print $2}' /sys/fs/cgroup/memory.stat)
    file=$(awk '/^file / {print $2}' /sys/fs/cgroup/memory.stat)
    kernel=$(awk '/^kernel / {print $2}' /sys/fs/cgroup/memory.stat)
    slab=$(awk '/^slab / {print $2}' /sys/fs/cgroup/memory.stat)
else
    ram_current=$(free -b | awk '/Mem:/ {print $3}')
    anon=0; file=0; kernel=0; slab=0
fi

ram_mb=$((ram_current / 1024 / 1024))
anon_mb=$((anon / 1024 / 1024))
file_mb=$((file / 1024 / 1024))
kernel_mb=$((kernel / 1024 / 1024))

ram_max=536870912 # 512 MB
ram_pct=$(( (ram_current * 100) / ram_max ))

print_bar() {
    val=$1
    [ $val -gt 100 ] && val=100
    [ $val -lt 0 ] && val=0
    filled=$((val / 5))
    empty=$((20 - filled))
    bar=""
    i=0
    while [ $i -lt $filled ]; do bar="${bar}█"; i=$((i + 1)); done
    i=0
    while [ $i -lt $empty ]; do bar="${bar}░"; i=$((i + 1)); done
    printf "[%s] %.1f%%\n" "$bar" "$2"
}

echo "----------------------------------------"
echo "🧠 ОПЕРАТИВНАЯ ПАМЯТЬ (RAM):"
echo "   - Всего в cgroup (memory.current): ${ram_mb} MB"
echo "     • Анонимная память (процессы):   ${anon_mb} MB"
echo "     • Файловый кэш (buffers/cache):  ${file_mb} MB"
echo "     • Ядро/прочее:                   ${kernel_mb} MB"
echo "   - Занято от лимита (512 MB):"
printf "     "
print_bar "$ram_pct" "$ram_pct"

echo ""
echo "⚡ ЗАГРУЗКА CPU (по истории Load Average):"
echo "   - За 1 мин:  Load: ${raw1}% | Лимит 0.2: "
printf "     "
print_bar "$(printf "%.0f" "$pct1")" "$pct1"

echo "   - За 5 мин:  Load: ${raw5}% "
printf "     "
print_bar "$(printf "%.0f" "$pct5")" "$pct5"

echo "   - За 15 мин: Load: ${raw15}% "
printf "     "
print_bar "$(printf "%.0f" "$pct15")" "$pct15"

echo "----------------------------------------"
