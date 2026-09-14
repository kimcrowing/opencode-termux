@echo off
rem ================================================================
rem  在【装好 NX 2606 的其它电脑】重建 NXRemoteServer.dll —— 单一事实源 = 本目录
rem  NXRemoteServer.cs。dll 二进制不入库（csc 派生物），clone 仓库后跑本命令即得。
rem  前置：NX 2606 装于 D:\Program Files\Siemens\Designcenter2606\NXBIN\managed
rem        （路径不符改下面 MGD）+ .NET Framework 4.0。
rem ================================================================
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set MGD=D:\Program Files\Siemens\Designcenter2606\NXBIN\managed
set FW=C:\Windows\Microsoft.NET\Framework64\v4.0.30319

%CSC% /nologo /target:library /out:C:\Users\<you>\NXRemoteServer.dll ^
 /r:"%MGD%\NXOpen.dll" ^
 /r:"%MGD%\NXOpen.UF.dll" ^
 /r:"%MGD%\NXOpen.Utilities.dll" ^
 /r:"%MGD%\NXOpenUI.dll" ^
 /r:"%FW%\System.Runtime.Remoting.dll" ^
 /r:System.dll /r:System.Core.dll ^
 "%~dp0NXRemoteServer.cs" 2>&1
echo === BUILD_EXIT:%ERRORLEVEL% ===
rem 之后：把 NXRemoteServer.dll 放进 NXUserDir\startup\（NX 2606 启动即自动加载，见 README 前置条件）。
move /y "C:\Users\<you>\NXRemoteServer.dll" "C:\Users\<you>\AppData\Local\Siemens\NX2606\startup\NXRemoteServer.dll"
