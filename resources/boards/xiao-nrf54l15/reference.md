# XIAO nRF54L15 Reference

## LED

- `LED.set([r, g, b])` — Set the RGB LED color (0-255 for each channel)

## GPIO

- `GPIO.set_output(pin)` — Set a pin as output
- `GPIO.write(pin, value)` — Write HIGH (1) or LOW (0) to a pin
- `GPIO.set_input(pin)` — Set a pin as input
- `GPIO.read(pin)` — Read a pin value (0 or 1)

## Sleep

- `sleep(seconds)` — Pause execution for the given number of seconds
