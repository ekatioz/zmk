# SPDX-License-Identifier: MIT

if(CONFIG_DISPLAY_DESIGNER AND CONFIG_ZMK_DISPLAY)
  zephyr_library()
  zephyr_library_include_directories(${CMAKE_SOURCE_DIR}/include)
  zephyr_library_sources(
    src/dd_render.c
    src/dd_screen.c
    src/generated/dd_assets.c
  )

  if(NOT CONFIG_ZMK_SPLIT OR CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
    zephyr_library_sources(src/generated/dd_layout_central.c)
  else()
    zephyr_library_sources(src/generated/dd_layout_peripheral.c)
  endif()
endif()
