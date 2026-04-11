# Makefile for OpenBlink VSCode Extension
# Builds mrbc (mruby bytecode compiler) for WebAssembly
# Requires Emscripten 5.0.5

# ============================================================================
# Configuration
# ============================================================================
EMSDK_VERSION    := 5.0.5
MRUBY_BUILD_CONFIG := mruby_build_config.rb
WASM_OUT_DIR     := resources/wasm
WASM_BUILD_DIR   := resources/wasm_build

# ============================================================================
# Build Targets
# ============================================================================

# Default target: build mrbc
all: mrbc

# Build mrbc (mruby bytecode compiler)
mrbc: check-emcc check-ruby
	@echo "Building mrbc (mruby bytecode compiler) with Emscripten $(EMSDK_VERSION)..."
	cd vendor/mruby && make
	cd vendor/mruby && rake MRUBY_CONFIG=../../$(MRUBY_BUILD_CONFIG)
	@echo "mrbc build complete. Output: $(WASM_OUT_DIR)/"

# ============================================================================
# Setup
# ============================================================================

# Setup Emscripten SDK (run once)
setup-emsdk:
	@test -d vendor/emsdk || { \
		echo "Error: vendor/emsdk not found. Run:"; \
		echo "  git submodule update --init --recursive"; \
		exit 1; \
	}
	@echo "Installing Emscripten $(EMSDK_VERSION)..."
	cd vendor/emsdk && ./emsdk install $(EMSDK_VERSION)
	cd vendor/emsdk && ./emsdk activate $(EMSDK_VERSION)
	@echo "Emscripten $(EMSDK_VERSION) setup complete."
	@echo "Run 'source vendor/emsdk/emsdk_env.sh' to activate."

# ============================================================================
# Prerequisite Checks
# ============================================================================

check-emcc:
	@command -v emcc >/dev/null 2>&1 || { \
		echo "Error: emcc not found. Run:"; \
		echo "  make setup-emsdk"; \
		echo "  source vendor/emsdk/emsdk_env.sh"; \
		exit 1; \
	}

check-ruby:
	@command -v ruby >/dev/null 2>&1 || { \
		echo "Error: ruby not found. Install Ruby to build mruby."; \
		exit 1; \
	}
	@command -v rake >/dev/null 2>&1 || { \
		echo "Error: rake not found. Install Ruby (with rake) to build mruby."; \
		exit 1; \
	}

# ============================================================================
# Clean
# ============================================================================

# Clean build artifacts
clean: clean-mrbc

clean-mrbc:
	@echo "Cleaning mrbc build artifacts..."
	cd vendor/mruby && make clean || true
	rm -rf $(WASM_BUILD_DIR)
	rm -f $(WASM_OUT_DIR)/mrbc.js $(WASM_OUT_DIR)/mrbc.wasm

# Rebuild
rebuild: clean all

# ============================================================================
# Help
# ============================================================================

help:
	@echo "OpenBlink VSCode Extension Build System"
	@echo ""
	@echo "Targets:"
	@echo "  all         - Build mrbc (default)"
	@echo "  setup-emsdk - Install and activate Emscripten $(EMSDK_VERSION)"
	@echo "  mrbc        - Build mrbc with prerequisite checks"
	@echo "  clean       - Remove all build artifacts"
	@echo "  clean-mrbc  - Remove mrbc build artifacts"
	@echo "  rebuild     - Clean and rebuild all"
	@echo "  help        - Show this help message"
	@echo ""
	@echo "First-time setup:"
	@echo "  git submodule update --init --recursive"
	@echo "  make setup-emsdk"
	@echo "  source vendor/emsdk/emsdk_env.sh"
	@echo "  make"

.PHONY: all setup-emsdk mrbc check-emcc check-ruby clean clean-mrbc rebuild help
