# Generic Board Reference

This board supports mruby/c standard library functions.

## Global Functions

- `puts(obj)` — Print object to stdout with newline
- `print(obj)` — Print object to stdout without newline
- `p(obj)` — Inspect and print object
- `sleep(seconds)` — Pause execution for the given number of seconds

## Object

Base class for all objects.

- `obj.class` — Return the class of obj
- `obj.to_s` — Convert to string
- `obj.inspect` — Return detailed string representation
- `obj.nil?` — Check if object is nil
- `obj == other` — Equality comparison
- `obj != other` — Inequality comparison
- `obj.hash` — Return hash code

## Array

Dynamic array collection.

### Creation
- `Array.new(size=0, obj=nil)` — Create new array
- `[1, 2, 3]` — Array literal syntax

### Methods
- `array[index]` — Get element at index
- `array[index] = value` — Set element at index
- `array.length` — Return array length
- `array.size` — Return array size (alias for length)
- `array.empty?` — Check if array is empty
- `array.push(item)` — Add item to end
- `array << item` — Append item (shorthand)
- `array.pop` — Remove and return last element
- `array.shift` — Remove and return first element
- `array.unshift(item)` — Add item to beginning
- `array.clear` — Remove all elements
- `array.include?(item)` — Check if item exists
- `array.index(item)` — Find index of item
- `array.first` — Return first element
- `array.last` — Return last element
- `array.reverse` — Return reversed array
- `array.sort` — Return sorted array
- `array.each { |item| ... }` — Iterate over elements
- `array.map { |item| ... }` — Transform elements
- `array.select { |item| ... }` — Filter elements
- `array + other_array` — Concatenate arrays
- `array - other_array` — Array difference
- `array & other_array` — Array intersection

## String

Text string manipulation.

### Creation
- `String.new` — Create empty string
- `"text"` — String literal syntax
- `'text'` — String literal syntax

### Methods
- `string.length` — Return string length
- `string.size` — Return string size (alias for length)
- `string.empty?` — Check if string is empty
- `string[index]` — Get character at index
- `string + other` — Concatenate strings
- `string * n` — Repeat string n times
- `string.upcase` — Convert to uppercase
- `string.downcase` — Convert to lowercase
- `string.reverse` — Reverse string
- `string.strip` — Remove whitespace from ends
- `string.lstrip` — Remove left whitespace
- `string.rstrip` — Remove right whitespace
- `string.chop` — Remove last character
- `string.chomp` — Remove trailing newline
- `string.split(separator)` — Split into array
- `string.include?(substr)` — Check if substring exists
- `string.index(substr)` — Find substring index
- `string.rindex(substr)` — Find substring from right
- `string.replace(other)` — Replace content
- `string.clear` — Make string empty
- `string.each_char { |c| ... }` — Iterate over characters
- `string.each_line { |line| ... }` — Iterate over lines

## Integer

Integer numbers.

### Methods
- `int.to_s` — Convert to string
- `int.to_f` — Convert to float
- `int.abs` — Absolute value
- `int.zero?` — Check if zero
- `int.even?` — Check if even
- `int.odd?` — Check if odd
- `int + other` — Addition
- `int - other` — Subtraction
- `int * other` — Multiplication
- `int / other` — Division
- `int % other` — Modulo
- `int ** other` — Exponentiation
- `int <=> other` — Comparison (-1, 0, 1)
- `int < other` — Less than
- `int <= other` — Less than or equal
- `int > other` — Greater than
- `int >= other` — Greater than or equal

## Float

Floating point numbers.

### Methods
- `float.to_s` — Convert to string
- `float.to_i` — Convert to integer
- `float.abs` — Absolute value
- `float.zero?` — Check if zero
- `float.floor` — Round down
- `float.ceil` — Round up
- `float.round` — Round to nearest
- `float + other` — Addition
- `float - other` — Subtraction
- `float * other` — Multiplication
- `float / other` — Division
- `float <=> other` — Comparison (-1, 0, 1)
- `float < other` — Less than
- `float <= other` — Less than or equal
- `float > other` — Greater than
- `float >= other` — Greater than or equal

## Hash

Key-value pairs collection.

### Creation
- `Hash.new` — Create empty hash
- `{key1: value1, key2: value2}` — Hash literal syntax

### Methods
- `hash[key]` — Get value by key
- `hash[key] = value` — Set value by key
- `hash.length` — Return number of pairs
- `hash.size` — Return hash size (alias for length)
- `hash.empty?` — Check if hash is empty
- `hash.keys` — Return array of keys
- `hash.values` — Return array of values
- `hash.has_key?(key)` — Check if key exists
- `hash.has_value?(value)` — Check if value exists
- `hash.delete(key)` — Remove key-value pair
- `hash.clear` — Remove all pairs
- `hash.each { |key, value| ... }` — Iterate over pairs

## Kernel

Global functions available to all objects.

- `puts(obj)` — Print with newline
- `print(obj)` — Print without newline
- `p(obj)` — Inspect print
- `sleep(seconds)` — Sleep for seconds
- `exit(status=0)` — Exit program
- `raise(message)` — Raise exception
- `loop { ... }` — Infinite loop
- `times { |i| ... }` — Repeat n times (Integer method)

## Math

Mathematical functions.

- `Math.sqrt(x)` — Square root
- `Math.sin(x)` — Sine
- `Math.cos(x)` — Cosine
- `Math.tan(x)` — Tangent
- `Math.asin(x)` — Arc sine
- `Math.acos(x)` — Arc cosine
- `Math.atan(x)` — Arc tangent
- `Math.atan2(y, x)` — Two-argument arctangent
- `Math.exp(x)` — Exponential
- `Math.log(x)` — Natural logarithm
- `Math.log10(x)` — Base-10 logarithm
- `Math::PI` — Pi constant
- `Math::E` — Euler's number

## Time

Time and date functions.

- `Time.now` — Current time
- `time.to_s` — Convert to string
- `time.to_i` — Convert to timestamp (seconds)

## Boolean (True/False/Nil)

- `true` — Boolean true
- `false` — Boolean false
- `nil` — Null value
- `obj.nil?` — Check if nil
- `obj & other` — Logical AND
- `obj | other` — Logical OR
- `obj ^ other` — Logical XOR
- `!obj` — Logical NOT
