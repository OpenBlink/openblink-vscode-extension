# M5 Stamp S3 参考文档

## LED

- `LED.set([r, g, b])` — 设置 RGB LED 颜色 (每个通道 0-255)

## GPIO

- `GPIO.set_output(pin)` — 将引脚设为输出
- `GPIO.write(pin, value)` — 向引脚写入 HIGH (1) 或 LOW (0)
- `GPIO.set_input(pin)` — 将引脚设为输入
- `GPIO.read(pin)` — 读取引脚值 (0 或 1)

## Sleep

- `sleep(seconds)` — 暂停执行指定秒数
