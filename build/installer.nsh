; NSIS 自定义安装脚本（由 package.json build.nsis.include 引入）
; 安装完成后静默安装 Microsoft Visual C++ 2015-2022 x64 运行库。
; 原因：onnxruntime-node / sharp 的原生 DLL（onnxruntime.dll、libvips）依赖较新的
; MSVC 运行时（msvcp140 / vcruntime140），部分用户系统缺失或版本过旧时，
; 应用启动会报 "A dynamic link library (DLL) initialization routine failed"（错误 1114）。
; vc_redist.x64.exe 通过 extraResources 随包发布在 resources 目录下。
; 退出码说明：0 成功；3010 成功但需重启；1638 系统已装有更新版本 —— 均视为正常。
!macro customInstall
  IfFileExists "$INSTDIR\resources\vc_redist.x64.exe" 0 skip_vcredist
    DetailPrint "正在安装 Microsoft Visual C++ 2015-2022 运行库..."
    ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /quiet /norestart' $1
    DetailPrint "VC++ 运行库安装退出码: $1"
  skip_vcredist:
!macroend
