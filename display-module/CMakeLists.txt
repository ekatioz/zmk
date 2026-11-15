# SPDX-License-Identifier: MIT

if(CONFIG_DISPLAY_DESIGNER AND CONFIG_ZMK_DISPLAY)
  zephyr_library()
  zephyr_library_include_directories(${CMAKE_SOURCE_DIR}/include)
  zephyr_library_sources(
    src/dd_render.c
    src/dd_link.c
    src/dd_time.c
    src/dd_timecalc.c
    src/dd_screen.c
    src/generated/dd_assets.c
  )

  # set by build-lily58.sh: the time of the build, used as the clock until it is set
  if(DEFINED DD_BUILD_EPOCH)
    zephyr_library_compile_definitions(
      DD_BUILD_EPOCH=${DD_BUILD_EPOCH}u
      DD_BUILD_UTC_OFFSET_MIN=${DD_BUILD_UTC_OFFSET_MIN}
    )
  endif()

  if(NOT CONFIG_ZMK_SPLIT OR CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
    zephyr_library_sources(src/generated/dd_layout_central.c)
  else()
    zephyr_library_sources(src/generated/dd_layout_peripheral.c)
  endif()
endif()
