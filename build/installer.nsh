; ============================================================================
; AstriaX 安装 / 卸载脚本
; ============================================================================
;
; 最重要的一件事：**更新时绝不能丢用户数据**
;
; 用户要求：「覆盖更新」「覆盖保数据更新」，以及
;   「必须是任何低版本到任何更新的版本，
;     即使是 0.1 或者 1.0 直接更新到 10.0 版本都能更新」
;
; 第二件事：**安装器 / 卸载器的界面也要是软件自己的样子**，
; 而且是「默认保留用户数据 + 让用户选」。
; 界面部分集中在下面「安装器界面」与「卸载器界面」两节，
; 和数据保护逻辑分开写，互不干扰。
;
; ----------------------------------------------------------------------------
; 踩到的坑（会真的删库）
; ----------------------------------------------------------------------------
;
; electron-builder 生成的安装包在**装新版之前会先调用旧版的卸载器**：
;
;   installSection.nsh:52   !insertmacro uninstallOldVersion SHELL_CONTEXT
;   installUtil.nsh:224     ExecWait '"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir'
;
; 而卸载器模板里 customUnInstall 是**无条件**执行的（它不看是不是在更新）：
;
;   uninstaller.nsh:238     !ifmacrodef customUnInstall
;   uninstaller.nsh:239       !insertmacro customUnInstall
;
; 原来的 customUnInstall 会把数据目录整个删掉（用户要求卸载不留 data），
; 于是「点一次更新 = 实例、运行时、配置全没」。
;
; 更麻烦的是：这次更新跑的是**旧版（0.1.0）已经编译好的卸载器**，
; 它根本不认识本文件的新逻辑。所以修复必须做到一件事：
;
;   **即使旧卸载器把 $INSTDIR 和 data 目录全删光，用户数据也要活着。**
;
; ----------------------------------------------------------------------------
; 做法
; ----------------------------------------------------------------------------
;
; customInit 的时机在 .onInit 里（installer.nsi:72），**早于**安装段调用旧卸载器
; （installSection.nsh:52）。趁这个空档把数据挪到旧卸载器够不着的地方：
;
;   情况 A · 同盘（绝大多数）
;     直接 Rename 到兄弟目录，**瞬间完成**（只改目录项，不搬内容）
;       E:\MXBot\data          →  E:\MXBot-update-keep\payload
;   情况 B · 数据在别的盘（比如程序装 C:、数据放 D:）
;     Rename 跨盘会失败，而且硬拷一份可能是几个 GB、要等好几分钟。
;     改用更省的办法：**把注册表里那个 DataRoot 值暂时清掉** ——
;     旧卸载器就是靠它决定删哪个目录的，清掉它，D:\ 上的原数据一动不动。
;   情况 C · 同盘但 Rename 失败（实例还在跑，文件被锁）
;     这种情况最危险：旧卸载器会去删 $INSTDIR\data（删一半、留一堆锁住的残file）。
;     所以**直接中止安装**，让用户先关掉 MXBot 和所有实例。
;
; 装完（customInstall）再把数据放回 origin.txt 记下的原位置。
;
; ----------------------------------------------------------------------------
; 为什么情况 A 用「移动」而 B 用「不搬」
; ----------------------------------------------------------------------------
;
; A 里数据本来就要换个地方待一会儿，同盘 Rename 是零成本的；
; B 里数据在**另一个盘**，而清注册表就能让它免于被删，没必要付复制的代价。
; 两种都保证「安装被中途取消时数据没有丢」：
;   - A：数据在 keep 目录里，下次运行安装包时 customInit 会把它放回去
;   - B：数据压根没动过
;
; ----------------------------------------------------------------------------
; 往后的更新（0.1.1 以后）
; ----------------------------------------------------------------------------
;
; customUnInstall 里判断是不是在更新，用的是安装器传进来的 `updated` 参数
; （installUtil.nsh:206：更新时固定带 `--updated`，手动卸载时没有）。
; 这个判断由 electron-builder 注入的 isUpdated 宏实现，它的定义是
; `${StdUtils.TestParameter} $R9 "updated"`（见生成的 builder-debug.yml）：
;   - 更新 → 一律不碰数据
;   - 用户在「控制面板 → 卸载程序」里真卸载 → 才清理数据
;
; 注意：即使这样，$INSTDIR 还是会被模板的 `RMDir /r $INSTDIR` 整个删掉，
; 所以**每次更新都还是要搬一次**（这是躲开模板删目录的唯一办法）。
;
; 另外：**只拦「完全相同」的版本**，比当前版本旧或新的安装包都放行 ——
; 用户明确要求任意低版本都能覆盖安装到任意更高版本。

; 备份落脚点：$INSTDIR 的兄弟目录
;
; **必须在 $INSTDIR 外面**：模板会 `RMDir /r $INSTDIR`，
; 放在里面等于没备份。
;
; 用变量而不是 `!define` 记住实际路径：`!define` 是**编译期文本替换**，
; 它在两处展开时读的 `$INSTDIR` 是**运行时**的值 —— 而用户可以在安装界面
; 改安装目录（allowToChangeInstallationDirectory: true）。那样 customInit 时
; $INSTDIR 还是旧位置、customInstall 时已经变成新位置，
; 重算出来的落脚点就不是同一个目录了，数据会搁浅。
; 所以 customInit 里算一次存进变量，customInstall 直接用。
Var /GLOBAL mxKeepDir

; 上一次 RESTORE 是否失败（"1" = 失败）
;
; 为什么需要这个标志：RESTORE 失败时会弹框告诉用户"数据还在
; $mxKeepDir\payload，请手动复制出去"，然后**故意不删 keep**。
; 但紧接着 customInit 就会调用 STASH，而 STASH 的第一件事是
; `RMDir /r "$mxKeepDir"` —— 于是刚说"还在"的那份唯一副本当场被删。
;
; 实测复现过（scripts/_probe-fatal-claims.cjs）：
;   AFTER_RESTORE=PRESENT      ← 弹框承诺保留，确实留着
;   AFTER_STASH=GONE           ← 下一行就没了
;
; 有了这个标志，customInit 在 RESTORE 失败后直接 Abort，
; 既不跑 STASH（不删备份），也不跑旧卸载器（不会再动 $INSTDIR）。
; 用户拿着弹框里的提示手工恢复即可。
/*
 * 这个变量只在**安装侧**用（customInit / RESTORE / STASH 三个宏里），
 * 而 electron-builder 编译 NSIS 要跑两遍：
 *   第一遍 BUILD_UNINSTALLER —— 只生成卸载器
 *   第二遍才是正常安装器
 * 它给 makensis 传了 /WX（警告当错误），于是卸载器那一遍会报：
 *   warning 6001: Variable "mxRestoreFailed" not referenced or never set
 *   Error: warning treated as error
 * 整条打包直接失败（ERR_ELECTRON_BUILDER_CANNOT_EXECUTE）。
 * 所以只在安装侧声明。
 */
!ifndef BUILD_UNINSTALLER
Var /GLOBAL mxRestoreFailed
!endif

; 数据目录指针文件名。必须和 src/main/store/root-pointer.ts 的
; ROOT_POINTER_FILE 逐字一致 —— 名字对不上，抢救逻辑会静默失效。
!define MXBOT_ROOT_POINTER "data-root.txt"

; ----------------------------------------------------------------------------
; 覆盖更新前自动备份用户数据
; ----------------------------------------------------------------------------
;
; 用户要求：「加入覆盖更新的时候会自动打包数据备份压缩包放在备份文件夹」。
;
; ## 为什么由**安装器**做，而不是程序做
;
; 用户要测的是 0.1.0 → 0.1.1。0.1.0 里没有新代码 —— 备份逻辑若写在程序里，
; 那么"更新到 0.1.1"这一次跑的仍是 0.1.0 的旧代码，**最需要保护的那一次
; 反而没有保护**。安装包永远是新版本的，所以放在这里才能覆盖
; 「任何低版本 → 任何高版本」（用户的原话要求）。
;
; ## 备份什么
;
; 只备份**丢了就再也弄不回来**的东西（用户原话：「astrbot+napcat 的用户数据
; 最重要，优先保住这个」）：
;
;   instances\       全部实例目录
;                    - AstrBot: data\cmd_config.json（账密/模型/插件/人格）
;                    - NapCat : config\*.json（QQ 账号、onebot token、webui）
;                    - cache\qrcode.png（登录二维码）
;   config.json      启动器配置（数据目录、端口段、备份保留数）
;   instances.json   实例清单
;   mirrors.json     用户自己加的镜像源
;   runtimes.json    装了哪些运行时版本（事后照着重装）
;
; **故意不备份**（都能重新下载，包进去会让每次更新白等几分钟）：
;   runtimes\  (实测 212 MB)  运行时本体
;   cache\     (实测 187 MB)  下载缓存
;   runtime\   (实测  40 MB)  内置 Python
;
; 实测真实数据（scripts/_probe-archiver.cjs）：
;   instances 只有 15.6 KB，tar 打包 **29ms**。
;   所以这个备份是"秒级、几十 KB"的，不会拖慢更新。
;
; ## 放在哪
;
;   <数据目录>\backups\update\<时间戳>\mxbot-data.tar.gz
;
; 为什么放数据目录里面而不是安装目录旁边：
;   1) 数据目录跟着数据走 —— 用户把数据迁到 D 盘，备份也跟着去 D 盘，
;      不会出现"数据在 D 盘、备份在 C 盘"的分裂；
;   2) 更新时 STASH 会把整个数据目录 Rename 到 keep 再搬回来，
;      备份在里面就**自动跟着往返**，不需要额外搬运逻辑；
;   3) 用户在界面上能通过"备份文件夹"找到它（同一棵树下）。
;
; 为什么不会自我递归：tar 只打 instances / *.json 这几项，
; **不含 backups\**，所以上一份备份不会被卷进下一份里。
!define MXBOT_BACKUP_SUBDIR "backups\update"

; ${GetTime} 来自 FileFunc.nsh。该文件自带 `!ifndef FILEFUNC_INCLUDED` 保护，
; 重复 include 不会重定义报错，所以可以放心加。
;
; 日期顺序用实测钉死（scripts/_probe-nsis-tar.cjs 的输出）：
;   ${GetTime} "" "L" $2 $3 $4 $5 $6 $7 $8
;   → r1=14 r2=09 r3=2026 r4=Monday r5=15 r6=14 r7=47
;   即 日=14 月=09 年=2026 星期=Monday 时=15 分=14 秒=47
;   （当时的真实时间就是 15:14:47，所以这个映射是验证过的，不是猜的）
!include "FileFunc.nsh"

/*
 * ${VersionCompare} 来自 **WordFunc.nsh**（不是 FileFunc！）
 *
 * 实测踩过：降级拦截用了 `${VersionCompare}`，只 include 了 FileFunc.nsh，
 * 编译直接报 `Invalid command: "${VersionCompare}"`。
 * 去 NSIS 的 Include 目录里数过：FileFunc.nsh 里只有 1 处提及（非定义），
 * WordFunc.nsh 里有 21 处 —— 定义在 WordFunc。
 * 写在这里记一笔，免得下次又凭印象 include 错文件。
 * （WordFunc.nsh 自带 `!ifndef WORDFUNC_INCLUDED` 守卫，重复包含不会重定义。）
 */
!include "WordFunc.nsh"

/*
 * ${StrContains} 来自 **TextFunc.nsh**
 *
 * 实测踩过（2026-09-27，加"卸载前先关闭正在运行的软件"时）：
 * 用了 `${StrContains}` 却没 include，**安装器那遍能过、卸载器那遍挂在 /WX**：
 *     Error in macro mxKillRunningApp on macroline 6
 *     Error in macro customUnInit on macroline 6
 * 两个宏都报"第 6 行"，其实指向的是同一个未定义命令。
 *
 * 注意：这个项目里以前只是**注释里提到** StrContains（第 1219 行说"不 include 它"），
 * 那时确实没用；现在真用上了，就必须 include。
 * （TextFunc.nsh 自带 `!ifndef TEXTFUNC_INCLUDED` 守卫，重复包含无害。）
 */
!include "TextFunc.nsh"

; 把 $INSTDIR\..\MXBot-update-keep 规范化后存进 mxKeepDir
;
; **只在第一次调用时生效**（幂等）。
;
; 这是本文件里最容易被忽略、后果又很实在的一处：$INSTDIR 在安装过程中
; 会**变两次** ——
;   .onInit（customInit 在这里跑）→ $INSTDIR 来自注册表里的旧安装位置
;   向导的目录页（MUI_PAGE_DIRECTORY）→ 用户可能改成新位置
;   安装段（customInstall 在这里跑）→ $INSTDIR 已经是新位置了
;
; 而 keep 目录是 "$INSTDIR\..\MXBot-update-keep" —— 依赖 $INSTDIR。
; 如果每次调用都重算：customInit 把数据搬到"旧位置的兄弟目录"，
; customInstall 却去"新位置的兄弟目录"找它 → 找不到 → 数据搁浅，
; 用户拿到一个新的空 data\（数据没丢，但程序不知道它在哪）。
;
; 幂等之后，全程用 customInit 那一刻算出的那一个值，和注释里的
; "算一次存进变量"终于是同一件事了。
!macro MXBOT_SET_KEEP
  ${If} $mxKeepDir == ""
    StrCpy $mxKeepDir "$INSTDIR\..\MXBot-update-keep"
  ${EndIf}
!macroend

; ----------------------------------------------------------------------------
; 剥掉一个变量尾部的空白与控制字符（CR / LF / 空格 / Tab）
;
; 为什么要专门做这件事：origin.txt / regroot.txt 是 NSIS 的 FileWrite 写的，
; 不保证没有换行；而换行混进路径里会让 Rename 拿到一个非法路径、
; 并且**不报错**地失败。逐个剥，一次调用只剥一个字符，所以下面调两次。
;
; **必须定义在使用它的宏之前** —— NSIS 的 !macro 是文本替换，
; 展开时那个宏得已经存在，否则编译直接报错。
; ----------------------------------------------------------------------------
!macro MXBOT_CHOMP VAR
  StrCpy $1 ${VAR} 1 -1
  ${If} $1 == "$\r"
  ${OrIf} $1 == "$\n"
  ${OrIf} $1 == " "
  ${OrIf} $1 == "$\t"
    StrCpy ${VAR} ${VAR} -1
  ${EndIf}
!macroend

; ----------------------------------------------------------------------------
; 从 keep 目录里读一个小文本文件到指定变量（去掉行尾 CR/LF）
; ----------------------------------------------------------------------------
!macro MXBOT_READLINE FILE OUTVAR
  StrCpy ${OUTVAR} ""
  ${If} ${FileExists} "${FILE}"
    ClearErrors
    FileOpen $9 "${FILE}" r
    FileRead $9 ${OUTVAR} 1024
    FileClose $9
    !insertmacro MXBOT_CHOMP ${OUTVAR}
    !insertmacro MXBOT_CHOMP ${OUTVAR}
  ${EndIf}
!macroend

; ----------------------------------------------------------------------------
; 判断一个 robocopy/nsExec 退出码字符串算不算"成功"
;
; 入参  $R6 = nsExec 压栈的字符串
; 出参  $R7 = "1" 成功 / "0" 失败
;
; ## 为什么不能用 `$R6 > 7`
;
; 原来写的是 `${If} $R6 > 7`，那是**整数比较**。而 nsExec 在
; **程序压根起不来**的时候（robocopy.exe 被 AppLocker / 杀软拦掉、
; PATH 被改坏、企业策略禁外部程序）往栈上压的不是数字，是字符串
; `"error"`。非数字在整数比较里既不大于也不小于任何数，于是
; `> 7` 判**假** → 走"成功"分支 → 紧接着 `RMDir /r "$mxKeepDir"`
; **把唯一一份备份删掉**。
;
; 而且这种情况下 nsExec 不设置 ${Errors}，没有第二道保险：
; 实测（scripts/_probe-fatal-claims.cjs）
;   POP=[error]
;   VERDICT=SUCCESS-BRANCH
;   ERRORS=CLEAR
;
; 用户看到"更新成功"，数据已经没了 —— 最坏的一种失败：
; 失败被当成成功，还顺手删掉了退路。
;
; robocopy 退出码语义（官方文档）：
;   0 无文件复制（已一致）      1 复制成功
;   2 有额外文件/目录           4 有不匹配的文件/目录
;   8 有文件复制失败           16 严重错误，未复制
; bit0-2 全为 1（0..7）才算可接受的成功。
; 逐串白名单比较，"error" / 8+ / 负数 / 空串 自然全落进失败分支。
;
; 抽成独立宏是为了**可反向验证**：改动它就能让验证脚本重新报错，
; 证明那些断言真的在盯这一行（否则就是假绿）。
; ----------------------------------------------------------------------------
!macro MXBOT_ROBO_VERDICT
  StrCpy $R7 "0"
  ${If} $R6 == "0"
  ${OrIf} $R6 == "1"
  ${OrIf} $R6 == "2"
  ${OrIf} $R6 == "3"
  ${OrIf} $R6 == "4"
  ${OrIf} $R6 == "5"
  ${OrIf} $R6 == "6"
  ${OrIf} $R6 == "7"
    StrCpy $R7 "1"
  ${EndIf}
!macroend

; ----------------------------------------------------------------------------
; 把数据放回原位（也用于上次安装中断后的抢救）
;
; 必须在 customInit 最开头调用。晚一步就会被后面的 RMDir 当成垃圾删掉，
; 那就是**真的把用户数据删了**。
;
; ## payload 是唯一权威副本 —— 绝不因为「原位置有东西」就丢掉它
;
; 这里原来写的是「原位置存在 → 说明原件没被删 → 直接 RMDir /r 掉 keep」。
; 这个判据是**错的**，而且错得会丢数据（独立审计实跑复现出来的场景）：
;
;   1. customInit 把 data Rename 到 keep\payload（**原位置此刻已经空了**）
;   2. 用户在向导第一页点「取消」/关窗口/断电 → 安装段永不执行
;      → 数据搁浅在 keep\payload，$INSTDIR\data 不存在
;   3. 用户照常双击启动器 → 发现没数据 → **首启向导弹出来**
;   4. 用户顺手把目录选回原来那个路径 → 程序新建了一个空壳 data\ + 新 config.json
;   5. 用户再跑一次安装包想救 → 旧判据看到「原位置存在」→ **把唯一的真数据删掉**
;
; 「原位置有东西」无法区分「原件还在」和「恢复后新建的空壳」。
; 所以现在改成：只要 payload 存在，它就是真数据，**合并/覆盖回原位置**，
; 而且**只有搬成功了才删 keep**。
;
; 用 robocopy 而不是 Rename 做合并：原位置可能已经被新建出目录来，
; Rename 到一个已存在的目录会失败；robocopy /E 是逐文件覆盖，
; 既能把 payload 的真实内容盖回去，又不会因为目标里多几个文件就出事。
; ----------------------------------------------------------------------------
!macro MXBOT_RESTORE_KEEP
  !insertmacro MXBOT_SET_KEEP

  /*
   * ---- 把数据目录指针（data-root.txt）放回安装目录 ----
   *
   * 独立于 payload 那一段：指针是**必须在安装目录里**的文件，
   * 而 payload 是用户数据，两者存在与否互不相关。
   * 所以单独判、单独搬，不塞进下面 payload 的 If 里。
   *
   * SetOverwrite on 是必须的：目标可能已被新装的文件占住，
   * 默认重试策略在静默安装下可能悄悄失败 → 指针又没了，等于白救。
   */
  ${If} ${FileExists} "$mxKeepDir\rootpointer.txt"
    SetOverwrite on
    ClearErrors
    CopyFiles /SILENT "$mxKeepDir\rootpointer.txt" "$INSTDIR\${MXBOT_ROOT_POINTER}"
    ${If} ${Errors}
      ; 拷不回去也不 Abort —— 数据没事，只是"下次启动要重选目录"。
      ; 但要在日志里留一句，别让它静默发生。
      DetailPrint "警告：数据目录指针回写失败，下次启动可能会要求重新选择数据目录"
    ${Else}
      DetailPrint "已恢复数据目录指针（${MXBOT_ROOT_POINTER}）"
    ${EndIf}
  ${EndIf}

  ${If} ${FileExists} "$mxKeepDir\payload\*.*"
    Push $R5
    Push $R6
    Push $R8

    ; 原位置
    !insertmacro MXBOT_READLINE "$mxKeepDir\origin.txt" $R8
    ; 情况 B 里被临时清掉的注册表值
    !insertmacro MXBOT_READLINE "$mxKeepDir\regroot.txt" $R5

    ${If} $R8 == ""
      ; 记录丢了：放回默认位置。总比把数据丢在 keep 里强。
      StrCpy $R8 "$INSTDIR\data"
    ${EndIf}

    ${If} ${FileExists} "$R8\*.*"
      ; 原位置已经有东西（可能是恢复后的空壳）→ **合并**，payload 覆盖同名文件
      DetailPrint "恢复数据（合并到已存在的 $R8）"
      nsExec::ExecToLog 'robocopy "$mxKeepDir\payload" "$R8" /E /R:1 /W:1 /NFL /NDL /NJH /NJS'
      Pop $R6
    ${Else}
      ; 原位置空着 → 走瞬间的 Rename
      ClearErrors
      Rename "$mxKeepDir\payload" "$R8"
      ; Rename 成功时不设 $R6（下面按"非失败"处理）
      StrCpy $R6 "0"
      ${If} ${Errors}
        DetailPrint "恢复数据（复制）：$mxKeepDir\payload → $R8"
        nsExec::ExecToLog 'robocopy "$mxKeepDir\payload" "$R8" /E /R:1 /W:1 /NFL /NDL /NJH /NJS'
        Pop $R6
      ${EndIf}
    ${EndIf}

    ; ------------------------------------------------------------------
    ; 判成功用**白名单**逐串比较（详见 MXBOT_ROBO_VERDICT 的注释）
    ; ------------------------------------------------------------------
    !insertmacro MXBOT_ROBO_VERDICT

    ${If} $R7 != "1"
      ; 恢复失败：**标记住**，让 customInit 别再往下跑（否则 STASH 会删备份）
      StrCpy $mxRestoreFailed "1"
      /*
       * `/SD IDOK` 不能省。
       *
       * NSIS 的 SilentInstall 只压掉**向导界面**，不压 MessageBox ——
       * 静默安装（`MXBot-Setup.exe /S`、自动更新）时对话框照样弹出来
       * 等用户点，自动化流程就**永久挂在那里**。
       * 实测（scripts/_probe-messagebox-silent.cjs）：
       *   不带 /SD   → 3 秒超时被杀掉（卡住）
       *   带 /SD IDOK → 132ms 自己过
       * 整个 installer.nsh 原来 3 个 MessageBox 全都没有 /SD。
       *
       * 这里给 IDOK：静默场景下等于"我知道了"，然后照常 Abort 停手，
       * 备份仍然保住（不会因为静默就把数据删了）。
       */
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "数据恢复失败。$\n$\n你的数据还在：$mxKeepDir\payload$\n请手动把里面的内容复制到：$R8$\n$\n（安装会就此停下，不会删除这份数据。恢复完成后可以重新运行安装包。）" \
        /SD IDOK
    ${Else}
      ; 恢复成功：把注册表值放回去（卸载器靠它找数据目录）
      ${If} $R5 != ""
        WriteRegStr HKCU "Software\MXBot" "DataRoot" "$R5"
      ${EndIf}
      RMDir /r "$mxKeepDir"
    ${EndIf}

    Pop $R8
    Pop $R6
    Pop $R5
  ${EndIf}
!macroend

; ----------------------------------------------------------------------------
; 覆盖更新前：自动把用户数据打包成备份压缩包
;
; 调用点：customInit 里、STASH **之前**（那时数据还在原位置，最容易读写）。
;
; 设计要点（每一条都是踩过或实测过的）：
;
;  1) **用 $R 寄存器 + Push/Pop，不声明全局 Var**
;     electron-builder 编译 NSIS 要跑两遍（BUILD_UNINSTALLER + 安装器），
;     且加了 /WX（警告当错误）。只在安装侧用到的 `Var /GLOBAL` 会让
;     卸载器那一遍报 `warning 6001: Variable "x" not referenced or never set`
;     → 打包直接失败。用寄存器就完全绕开这个问题。
;     （本文件 :107 那段 mxRestoreFailed 的注释记的就是同一个坑。）
;
;  2) **必须真的验产物，不能只看退出码**
;     nsExec 的退出码在有些情况下不可靠，而 0 字节的坏压缩包"存在"
;     也满足 ${FileExists}。所以读首字节判 gzip 魔数 0x1F（31）。
;     实测（scripts/_probe-nsis-tar.cjs）validated 过这个判据。
;
;  3) **备份绝不能因为失败而中断安装**
;     这是"额外的保险"，不是安装的前置条件。tar 不在、磁盘满是用户的事，
;     但不能因此让他装不上更新。所有失败路径都只 DetailPrint + 弹提示。
;
;  4) 打包清单**逐项判存在**再加进去
;     tar 对不存在的文件会报错并非零退出（虽然仍会生成包），
;     而 config.json / mirrors.json 这些在某些安装里确实可能不存在。
;     逐项判存在，命令才干净、退出码才有意义。
; ----------------------------------------------------------------------------
!macro MXBOT_UPDATE_BACKUP
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $8
  Push $9

  ; ---- 1) 确定数据目录（与 STASH 用同一套判断：注册表优先）----
  StrCpy $R0 ""
  ${If} ${FileExists} "$INSTDIR\data\*.*"
    StrCpy $R0 "$INSTDIR\data"
  ${EndIf}
  ReadRegStr $R7 HKCU "Software\MXBot" "DataRoot"
  ${If} $R7 != ""
  ${AndIf} ${FileExists} "$R7\*.*"
    StrCpy $R0 "$R7"
  ${EndIf}

  ${If} $R0 == ""
    DetailPrint "更新前备份：没有找到数据目录，跳过（首次安装属于正常情况）"
  ${Else}

    ; ---- 2) 时间戳（日期字段顺序由实测钉死，见文件头 GetTime 注释）----
    ${GetTime} "" "L" $R3 $R2 $R1 $R5 $R6 $R7 $9
    ; 拼成 20260914-151447
    StrCpy $R4 "$R1$R2$R3-$R6$R7$9"

    ; ---- 3) 建备份目录 ----
    StrCpy $R2 "$R0\${MXBOT_BACKUP_SUBDIR}\$R4"
    CreateDirectory "$R2"

    ; ---- 4) 逐项拼打包清单（只加真实存在的）----
    StrCpy $R5 ""
    ${If} ${FileExists} "$R0\instances\*.*"
      StrCpy $R5 "$R5 instances"
    ${EndIf}
    ${If} ${FileExists} "$R0\config.json"
      StrCpy $R5 "$R5 config.json"
    ${EndIf}
    ${If} ${FileExists} "$R0\instances.json"
      StrCpy $R5 "$R5 instances.json"
    ${EndIf}
    ${If} ${FileExists} "$R0\mirrors.json"
      StrCpy $R5 "$R5 mirrors.json"
    ${EndIf}
    ${If} ${FileExists} "$R0\runtimes.json"
      StrCpy $R5 "$R5 runtimes.json"
    ${EndIf}

    ${If} $R5 == ""
      DetailPrint "更新前备份：数据目录里没有需要备份的内容，跳过"
    ${Else}

      ; ---- 5) 选 tar.exe ----
      /*
       * 安装包是 **32 位**进程，在 64 位 Windows 上访问 $WINDIR\System32
       * 会被 WOW64 重定向到 SysWOW64。实测（scripts/_probe-nsis-tar.cjs）
       * 三条路径都能真的产出 gzip 包，优先用 Sysnative（32 位进程访问
       * 真 System32 的正规别名，若系统装了 64 位 tar 会用上它），
       * 退而用 System32（在 32 位系统或未重定向时正确），
       * 再退 SysWOW64（重定向后的落点，实测确实有 32 位 tar）。
       */
      StrCpy $R4 "$WINDIR\Sysnative\tar.exe"
      ${IfNot} ${FileExists} "$R4"
        StrCpy $R4 "$WINDIR\System32\tar.exe"
      ${EndIf}
      ${IfNot} ${FileExists} "$R4"
        StrCpy $R4 "$WINDIR\SysWOW64\tar.exe"
      ${EndIf}

      ${If} ${FileExists} "$R4"
        StrCpy $R3 "$R2\mxbot-data.tar.gz"
        Delete "$R3"

        /*
         * -czf <产物> -C <数据目录> <清单...>
         *   -C 让包里的路径是相对的（instances/... 而不是一长串绝对路径），
         *   用户手工解开时结构清晰，也不泄露他的盘符路径。
         */
        nsExec::ExecToStack '"$R4" -czf "$R3" -C "$R0"$R5'
        Pop $R6
        Pop $R7

        ; ---- 6) 验产物：必须存在且首字节是 gzip 魔数 0x1F ----
        StrCpy $R1 "0"
        ${If} ${FileExists} "$R3"
          ClearErrors
          FileOpen $8 "$R3" r
          FileReadByte $8 $9
          FileClose $8
          ${If} $9 == 31
            StrCpy $R1 "1"
          ${EndIf}
        ${EndIf}

        ${If} $R1 == "1"
          DetailPrint "更新前备份完成：$R3"
        ${Else}
          /*
           * 失败不能中断安装（理由见宏头注释第 3 条），但**必须让用户知道**，
           * 否则他以为"有备份"、真出事时才发现没有 —— 那比没有备份更糟。
           *
           * /SD IDOK 不能省：静默安装时 MessageBox 照样弹，
           * 没有 /SD 会让自动更新**永久卡住**（本文件 :330 有实测记录）。
           */
          DetailPrint "警告：更新前备份失败（tar 退出码 $R6）"
          RMDir /r "$R2"
          MessageBox MB_OK|MB_ICONEXCLAMATION \
            "更新前自动备份没能完成。$\n$\n更新本身会照常进行，你的数据也不会被删（更新流程有独立的数据保护）。$\n$\n但如果你希望万无一失，可以先手动把数据目录复制一份：$\n$R0" \
            /SD IDOK
        ${EndIf}
      ${Else}
        DetailPrint "警告：系统里找不到 tar.exe，跳过更新前备份"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  Pop $9
  Pop $8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

; ----------------------------------------------------------------------------
; 把当前数据目录保护起来
;
; 保护哪个：优先注册表里记的 DataRoot（用户可能在设置里改过路径），
; 否则用默认的 $INSTDIR\data。App 只用一个 dataRoot，所以只需处理一个。
; ----------------------------------------------------------------------------
!macro MXBOT_STASH_KEEP
  /*
   * ---- 第一道闸门：上一次恢复失败就绝不碰 keep ----
   *
   * customInit 里已经有一道 `$mxRestoreFailed == "1" → Abort`，
   * 为什么这里还要再来一道？因为**宏可以被任何地方调用**：
   * customInit 只是当前唯一的调用点，将来若有人把它挪到别的段、
   * 或从 customInstall 再调一次，那道 Abort 就绕过去了。
   *
   * 而这里要删的 `$mxKeepDir` 是**恢复失败时唯一剩下的那份数据**：
   * RESTORE 弹框明确承诺过"你的数据还在 $mxKeepDir\payload"。
   * 这种"删掉用户最后退路"的操作，值得在**执行点本身**再拦一次，
   * 而不是只依赖调用方的自觉。两道闸门的代价是 4 行，收益是
   * "无论怎么调都不会删掉救命备份"。
   *
   * 实测（scripts/_probe-fatal-claims.cjs）证实这道闸门不冗余：
   * 单独调 RESTORE + STASH 两个宏（不经过 customInit）时，
   * STASH 的 `RMDir /r "$mxKeepDir"` 会真的把 payload 删掉 ——
   *   AFTER_RESTORE=PRESENT
   *   AFTER_STASH=GONE
   * 也就是说：**没有这道闸门，只靠 customInit 的 Abort 是不够的**。
   *
   * 用 `${If} != "1"` 把整个宏体包起来，**不用 Return**：
   * 宏是编译期展开的，`Return` 会跳回调用者的函数——
   * customInit 现在展开在 `.onInit` 里，Return 恰好等于"结束 .onInit"，
   * 看似能用；但这个宏将来若被放进某个 Section 或嵌在别的宏里，
   * Return 的语义就完全变了（Section 里 Return 只是提前结束该段）。
   * 包一层 If 在任何上下文里行为都一样，不必依赖调用位置。
   */
  ${If} $mxRestoreFailed != "1"
    /*
     * 落脚点**只算一次**，在 customInit 里算好之后就不许再动。
     *
     * 原来这里（以及 RESTORE 里）都各自调了一次 MXBOT_SET_KEEP，
     * 每次都按**当前**的 $INSTDIR 重算 —— 而这一点和上面 :85-90 的注释
     * 是矛盾的（注释写"算一次存进变量"，代码却算三次）。
     *
     * 为什么这会造成数据搁浅：customInit 跑在 .onInit，那时 $INSTDIR
     * 来自注册表的 InstallLocation；而 MUI_PAGE_DIRECTORY 是**之后的**
     * 向导页。用户在已有安装上重跑安装包并改了安装目录时：
     *   customInit（旧目录）→ keep = 旧目录的兄弟目录 → 数据搬到那里
     *   customInstall（新目录）→ keep = 新目录的兄弟目录 → 找不到 payload
     * 数据就无声地留在旧目录旁边，程序拿到一个新的空 data\。
     *
     * 现在 $mxKeepDir 只在 customInit 开头算一次，RESTORE/STASH 都直接用。
     */
    ${If} $mxKeepDir == ""
      !insertmacro MXBOT_SET_KEEP
    ${EndIf}

  StrCpy $R6 ""

  ; 默认位置
  ${If} ${FileExists} "$INSTDIR\data\*.*"
    StrCpy $R6 "$INSTDIR\data"
  ${EndIf}
  ; 注册表里的（程序运行时写的，见 src/main/ipc.ts 的 recordDataRootForUninstall）
  ReadRegStr $R7 HKCU "Software\MXBot" "DataRoot"
  ${If} $R7 != ""
  ${AndIf} ${FileExists} "$R7\*.*"
    StrCpy $R6 "$R7"
  ${EndIf}

  ${If} $R6 != ""
    /*
     * ══════════════════════════════════════════════════════════════════════
     * ★★ 回来过一趟的"原地覆盖快路径"——**已回退，不要再加回来** ★★
     * ══════════════════════════════════════════════════════════════════════
     *
     * 2026-09-26 主人要求「确保更新覆盖是覆盖，而不是先卸载再安装这种多余的操作」。
     * 我据此加了 `MXBOT_SKIP_STASH` 快路径：当数据就在 $INSTDIR\data、
     * 注册表无 DataRoot、无 data-root.txt 时，**跳过 STASH 搬家**。
     * 当时的推理是（**错的**）：
     *   「/KEEP_APP_DATA + --updated 让卸载器不删数据，所以没人会动 data，
     *     这次搬家纯属往返开销。」
     *
     * ## 为什么这个推理是错的（真机 e2e 抓出来的，主编自己复现过）
     *
     * `--updated` 只让**我们自己的** `customUnInstall` 跳过删除逻辑。
     * 而删 `$INSTDIR\data` 的是 **electron-builder 的卸载器模板**，
     * 那段代码根本不看 customUnInstall：
     *
     *   uninstaller.nsh:148-166  ${if} ${isUpdated}
     *                              Call un.atomicRMDir   ← 把 $INSTDIR 下所有内容
     *                                                      （含 data\）**Rename 到
     *                                                      $PLUGINSDIR\old-install**
     *   uninstaller.nsh:169      RMDir /r $INSTDIR       ← 无条件
     *
     * `$PLUGINSDIR` 是临时目录，卸载器进程一退出就被清理 ——
     * **数据就这么没了**。讽刺的是 `--updated` 让它走的是**更激进**的分支。
     *
     * 真机证据（scripts/test-installer-e2e.cjs，CASE 5）：
     *     快路径开启（当时的现状）→ config.json / 实例数据 / 运行时 **全 GONE**
     *     快路径关掉（恒走搬家）  → 全部 ALIVE
     * 对照组一开就证明因果在快路径身上，不是实验环境问题。
     *
     * ## 还有两个放大因素
     *
     *   1. **老用户 100% 命中**：HEAD（已发布的 0.1.0）没有 root-pointer 逻辑，
     *      从不写 `data-root.txt`，所以第三条判据 `FileExists` 天然为假 →
     *      条件成立 → 必然跳过搬家 → 必然丢数据。这不是边缘场景，是主干。
     *   2. **单测假绿**：当时新加的那组 vitest 断言只匹配源码里的字符串与顺序，
     *      把 `StrCpy $R8 "1"` 改成恒 "1"（=必丢数据）它照样全绿。
     *      真正抓到问题的是**真机 e2e**。
     *
     * [教训] 「文件层面确实是覆盖」不等于「数据安全」。判断"卸载器会不会动
     *        某个目录"时，**必须去看卸载器模板本身**，而不是看我们自己的
     *        custom 宏里有没有守卫 —— 模板不读 custom 宏。
     * [教训] 数据安全类的改动，**单测不算证据**。必须跑
     *        `node scripts/test-installer-e2e.cjs`（真编译、真跑、真断言文件）。
     *
     * ## 现在：`$R8` 恒为 "0"（永远走搬家）
     *
     * 保留变量本身是为了让下面的分支结构不动（改动面最小、最好核对）。
     * 那个"往返开销"其实只是两次目录改名，近乎零成本，不值得为省它冒险。
     */
    StrCpy $R8 "0"
    ${If} $R8 == "0"
    Push $R2
    Push $R3

    ; 落脚点要干净
    RMDir /r "$mxKeepDir"
    CreateDirectory "$mxKeepDir"

    /*
     * ---- 先把 data-root.txt 抢救出来 ----
     *
     * 它是应用启动时定位数据目录的**唯一线索**（应用侧不读注册表兜底）。
     * 用户迁移过数据目录后，程序把新路径写进 <安装目录>\data-root.txt；
     * 而覆盖更新时旧卸载器会 RMDir /r "$INSTDIR" —— 它正好躺在里面，
     * **每次更新都被删**。
     *
     * 后果不是数据丢，而是指针丢：更新完第一次启动退回默认位置、
     * 那儿是空的 → 弹首启向导要你重选目录。用户会以为"更新把数据弄没了"，
     * 只要他随手选了默认位置，D 盘那套真数据就再也想不起来了。
     *
     * 放在这里（Rename payload 之前、旧卸载器跑之前）读到的就是最新那份。
     */
    ${If} ${FileExists} "$INSTDIR\${MXBOT_ROOT_POINTER}"
      CopyFiles /SILENT "$INSTDIR\${MXBOT_ROOT_POINTER}" "$mxKeepDir\rootpointer.txt"
      DetailPrint "已备份数据目录指针（${MXBOT_ROOT_POINTER}）"
    ${EndIf}

    ClearErrors
    Rename "$R6" "$mxKeepDir\payload"
    ${If} ${Errors}
      ; ---- Rename 失败：先分清是「跨盘」还是「被锁住」----
      StrCpy $R2 "$R6" 2        ; 例如 "D:"
      StrCpy $R3 "$mxKeepDir" 2 ; 例如 "C:"

      ${If} $R2 != $R3
        ; ===== 情况 B：数据在另一个盘 =====
        ;
        ; 不复制（可能是几个 GB）。改把注册表里的 DataRoot 暂时清掉 ——
        ; 旧卸载器正是靠这个值决定删哪个目录的，清掉它，
        ; 数据原封不动地留在原盘，装完再写回去。
        DetailPrint "数据在其它盘（$R6）：临时摘掉注册表记录以保护它"
        ReadRegStr $R7 HKCU "Software\MXBot" "DataRoot"
        ${If} $R7 != ""
          FileOpen $9 "$mxKeepDir\regroot.txt" w
          FileWrite $9 "$R7"
          FileClose $9
          DeleteRegValue HKCU "Software\MXBot" "DataRoot"
        ${EndIf}
      ${Else}
        ; ===== 情况 C：同盘却动不了 → 文件被占用 =====
        ;
        ; 这时旧卸载器会去删 $INSTDIR\data，把能删的删掉、锁住的留下，
        ; 结果是一个残缺目录（用户报告过的「运行时被删一半」就是这么来的）。
        ; **必须中止**，不能硬着头皮往下走。
        ;
        ; `/SD IDOK` 必须有：静默安装时这个框照样会弹，没有 /SD 就永久挂住。
        ; （见 build/installer.nsh 里 Recover 失败那段的实测数据。）
        MessageBox MB_OK|MB_ICONSTOP \
          "无法保护数据目录：$R6$\n$\n它正被其他程序占用（多半是 AstriaX 或某个正在运行的实例）。$\n$\n请先完全退出 AstriaX、AstrBot、NapCat 和 QQ，再重新运行本安装包。" \
          /SD IDOK
        Abort
      ${EndIf}
    ${EndIf}

    ; 记下原位置，装完放回去
    FileOpen $9 "$mxKeepDir\origin.txt" w
    FileWrite $9 "$R6"
    FileClose $9

    Pop $R3
    Pop $R2
    ${EndIf}   ; MXBOT_SKIP_STASH 快路径的结束（$R8=="0" 才搬家）
  ${EndIf}
  ${Else}
    DetailPrint "上次数据恢复失败：保留 $mxKeepDir 不动作（避免删掉唯一备份）"
  ${EndIf}
!macroend

; ============================================================================
; 界面
; ============================================================================
;
; ## 这一段的需求变过一次（方向是"收窄"），留档避免反复
;
; 最初主人要求：「安装器和卸载器的界面和UI也改成软件风格的，而不是默认的」。
; 我据此做了三件事：
;   1. 用 logo 生成三张向导图，挂在 nsis.installerSidebar / installerHeader
;   2. 自绘欢迎页（26pt 大字 AstriaX）+ 品牌配色 + 自绘外壳按钮
;   3. 卸载器的「数据处置」页
;
; 看过**实际界面截图**之后，主人说：
;   「那就只改文案，不改图标和样式吧」
; 于是 1 和 2 全部撤掉了。现在这里只剩：
;
;   · 欢迎页 / 完成页的**文案**（下面两个宏，用原生 MUI 页）
;   · 卸载器的「数据处置」页 —— 这是**功能**不是样式，保留
;     （默认保留数据 / 可一起删除 / 可取消卸载）
;
; 换句话说：**安装器外观回到 NSIS 原生**，只有文字是我们的。
;
; （那三张 BMP 还留在 build/ 下没删 —— 它们不参与打包，
;   留着是万一以后想恢复，不必重跑生成脚本。相关脚本：
;   scripts/_make-installer-art.cjs）
;

; nsDialogs 仍然需要 —— 卸载器的「数据处置」页是用它画的。
; 它自带 WinMessages.nsh，且有 !ifndef NSDIALOGS_INCLUDED 保护，重复 include 无害。
; 注意：这里不再有自绘的颜色/字号 define（主人要求「不改样式」）。
!include "nsDialogs.nsh"

; ---------------------------------------------------------------------------
; 安装向导：欢迎页
; ---------------------------------------------------------------------------
;
; 主人要求：「安装器不要写多余文案，直接就写 AstriaX 安装向导」→
;           「只改文案，不改图标和样式」→
;           「加点文案在下面，太空了，就写B站那个谁做的声明吧，
;             用可爱风无emoji无颜文字说」。
;
; 所以这里：**原生 MUI 欢迎页 + 只换文字**，不碰字号/配色/按钮。
;   · 标题：AstriaX 安装向导
;   · 正文：B站 UP 主「梦见月下汐」的著作声明
;
; ## 文案要点（跟程序里那个首启弹窗保持一致的口径）
;
;   · 谁做的：B站 UP 主「梦见月下汐」
;   · 公益免费：不收钱、没广告、没内购
;   · 反倒卖提醒：有人收钱就是被倒卖了
;
; ## 为什么用 $\r$\n 而不是 $\n
;
; MUI 的欢迎页文本显示在静态控件里，换行必须用 `$\r$\n`
; （Windows 的换行约定）。只写 `$\n` 时控件往往不分行、整段挤成一行。
;
; ## 可爱风但守规矩
;
; 主人的硬要求：**不用 emoji、不用颜文字**。所以可爱只能靠语气词和 `~`：
; 用「呀 / 哦 / 啦」这类语气收尾，不写 (｡･ω･｡) 之类。
; 文案也不能长 —— 欢迎页正文区域就那么高，超过会被截断，
; 所以写在 4 行以内。
; ---------------------------------------------------------------------------
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "AstriaX 安装向导"
  !define MUI_WELCOMEPAGE_TEXT "这个小家伙是 B站 UP 主「梦见月下汐」一个人做出来的哦~$\r$\n$\r$\n它是完全免费的公益软件，不收钱、没广告、也没有内购，装好就是完整的样子啦。$\r$\n$\r$\n要是有人向你收过钱，那一定是被倒卖了呀，记得找他要回来哦。"
  !insertmacro MUI_PAGE_WELCOME
!macroend


; ---------------------------------------------------------------------------
; 安装向导：完成页
;
; ## 为什么必须自己再写一遍「装完启动」那个勾
;
; assistedInstaller.nsh 里的默认完成页带着一个「运行程序」勾选框，
; 它的 StartApp 函数定义在那段默认代码里（assistedInstaller.nsh:51-58）。
; 一旦我们定义了 customFinishPage，那段默认代码**整段被跳过**
; （它俩是 !ifmacrodef / !else 的关系），于是勾选框和它的函数一起消失 ——
; 用户装完就少了一个"立刻打开"的入口。
;
; 所以这里把 StartApp 原样补回来（函数改名 mxStartApp，避免和
; common.nsh 里的同名宏撞车），并保留 --updated 参数语义：
; 覆盖更新后启动时带 --updated，程序据此知道该走更新后的分支。
; ---------------------------------------------------------------------------
!macro customFinishPage
  Function mxStartApp
    ${If} ${isUpdated}
      StrCpy $1 "--updated"
    ${Else}
      StrCpy $1 ""
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  /* 主人要求「不要多余文案」，完成页同样只留一句必要信息 */
  !define MUI_FINISHPAGE_TITLE "AstriaX 安装完成"
  !define MUI_FINISHPAGE_TEXT " "
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "立刻启动 AstriaX"
  !define MUI_FINISHPAGE_RUN_FUNCTION "mxStartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend

; ============================================================================
; 卸载器界面：数据处置页
; ============================================================================
;
; 主人要求：「卸载器加一个是否保留用户数据的选项，默认保留，
;           还要加个不舍卸载的选项」。
;
; ---------------------------------------------------------------------------
; 为什么这一页必须放在**卸载器欢迎页**的位置
; ---------------------------------------------------------------------------
;
; 卸载器的页面顺序是（assistedInstaller.nsh:65-81）：
;
;   UNPAGE_WELCOME（可被 customUnWelcomePage 替换）   ← 数据选择放这里
;   PAGE_INSTALL_MODE
;   UNPAGE_INSTFILES                                  ← 到这儿才开始删文件
;   customUninstallPage
;   UNPAGE_FINISH
;
; 真正的删除发生在 UNPAGE_INSTFILES 里的 `Section "un.install"`。
; 而 electron-builder 提供的 customUninstallPage 是插在**删除之后**的，
; 那时候问已经晚了 —— 数据没了才问要不要留，是纯粹的嘲讽。
;
; 所以必须占用第一个页面：用户在删任何东西之前就把选择做完。
;
; ---------------------------------------------------------------------------
; 为什么三个选项用「自绘 radio + 自己管互斥」
; ---------------------------------------------------------------------------
;
; NSD_CreateRadioButton 生成的按钮每个都带 WS_GROUP，按 Win32 规则
; 那会让它们各自成为**独立分组**，点第二个时第一个不会被取消 ——
; 也就是"能同时选中两个"。这在数据删除这种场景里是不可接受的歧义。
;
; 所以不依赖系统分组：三个按钮各挂一个 onClick，手动把另外两个取消。
; 无论系统怎么分组，结果都只有一个被选中。
; ---------------------------------------------------------------------------
!ifdef BUILD_UNINSTALLER
  /* 用户的选择："" = 没问过（静默）/ "1" = 保留 / "2" = 删除 / "3" = 先不卸载 */
  Var /GLOBAL mxDataChoice
  Var /GLOBAL mxR1
  Var /GLOBAL mxR2
  Var /GLOBAL mxR3

  !macro customUnWelcomePage
    UninstPage custom un.mxDataPageCreate un.mxDataPageLeave
  !macroend

  Function un.mxDataPageCreate
    /*
     * 数据目录的位置跟 customUnInstall 用**同一套规则**：
     * 优先读注册表（用户可能把数据迁到别的盘），没有再退回 $INSTDIR\data。
     * 两处规则必须一致 —— 否则会出现"页面说你数据在 A、实际删的是 B"。
     */
    ReadRegStr $R0 HKCU "Software\MXBot" "DataRoot"
    ${If} $R0 == ""
      StrCpy $R0 "$INSTDIR\data"
    ${EndIf}

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    /*
     * 这一段**不做任何配色/字号美化**。
     *
     * 主人要求：「只改文案，不改图标和样式」。
     * 所以这里只用 nsDialogs 把内容摆出来，颜色字号全交给系统默认 ——
     * 之前那套 SetCtlColors ${MX_UI_*} / CreateFont 26pt 的做法已删除，
     * 对应的 MX_UI_* define 也一并删了（留着会"未使用变量"报错）。
     *
     * ## 文案风格
     *
     * 主人要求：「卸载器也是一样的，可爱文案」。
     * 所以语气跟安装器欢迎页**同一套**：
     *   · 可爱但克制：只用语气词（呀/哦/啦/呢）和 `~`
     *   · **不用 emoji、不用颜文字**（主人的硬要求）
     *   · 危险动作（删数据）不许卖萌卖到看不清后果 ——
     *     「删了就找不回来了」这种话必须留全，可爱不能吃掉准确性
     *
     * 功能一个都不少：三个选项、默认选中「保留」、页面路径与
     * customUnInstall 用同一套规则。
     */

    /* ---- 标题 ---- */
    ${NSD_CreateLabel} 0 0 100% 14u "要跟 AstriaX 说再见了吗"
    Pop $1

    ${NSD_CreateLabel} 0 18u 100% 22u "程序文件会被删掉哦。实例、配置和登录状态可以留着，也可以一起清掉~$\r$\n选好之后点「下一步」就好啦。"
    Pop $1

    /* ---- 数据目录位置（让用户看清要动的是哪个目录）---- */
    ${NSD_CreateLabel} 0 44u 100% 10u "你的数据现在放在这里："
    Pop $1

    ${NSD_CreateLabel} 0 55u 100% 12u "$R0"
    Pop $1

    /* ---- 三个互斥选项 ---- */
    ${NSD_CreateRadioButton} 0 76u 100% 11u "留着数据，只删程序（推荐哦）"
    Pop $mxR1
    ${NSD_CreateRadioButton} 0 90u 100% 11u "连数据一起删掉（删了就真的找不回来了呀）"
    Pop $mxR2
    ${NSD_CreateRadioButton} 0 104u 100% 11u "算了算了，先不卸载了，全都留着"
    Pop $mxR3

    /* 默认落在「保留」上 —— 用户什么都不改也不会丢数据 */
    ${NSD_SetState} $mxR1 ${BST_CHECKED}
    StrCpy $mxDataChoice "1"

    ${NSD_OnClick} $mxR1 un.mxPick1
    ${NSD_OnClick} $mxR2 un.mxPick2
    ${NSD_OnClick} $mxR3 un.mxPick3

    ${NSD_CreateLabel} 0 124u 100% 20u "更新软件的时候会自动跳过这一步，更新永远不会删你的数据哦。"
    Pop $1

    nsDialogs::Show
  FunctionEnd

  /* 下面三个只做一件事：把自己选中、把另外两个取消。 */
  Function un.mxPick1
    ${NSD_SetState} $mxR1 ${BST_CHECKED}
    ${NSD_SetState} $mxR2 ${BST_UNCHECKED}
    ${NSD_SetState} $mxR3 ${BST_UNCHECKED}
    StrCpy $mxDataChoice "1"
  FunctionEnd

  Function un.mxPick2
    ${NSD_SetState} $mxR1 ${BST_UNCHECKED}
    ${NSD_SetState} $mxR2 ${BST_CHECKED}
    ${NSD_SetState} $mxR3 ${BST_UNCHECKED}
    StrCpy $mxDataChoice "2"
  FunctionEnd

  Function un.mxPick3
    ${NSD_SetState} $mxR1 ${BST_UNCHECKED}
    ${NSD_SetState} $mxR2 ${BST_UNCHECKED}
    ${NSD_SetState} $mxR3 ${BST_CHECKED}
    StrCpy $mxDataChoice "3"
  FunctionEnd

  Function un.mxDataPageLeave
    /*
     * 「先不卸载了」= 立刻退出卸载器。
     *
     * 用 Quit 而不是 Abort：Abort 只是留在本页（用户会以为自己点错了，
     * 反复点也出不去）；Quit 才是"这个卸载器我不跑了、什么都不动"。
     */
    ${NSD_GetState} $mxR3 $0
    ${If} $0 == ${BST_CHECKED}
      Quit
    ${EndIf}

    ${NSD_GetState} $mxR2 $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $mxDataChoice "2"
    ${Else}
      StrCpy $mxDataChoice "1"
    ${EndIf}
  FunctionEnd

  ; ---------------------------------------------------------------------------
  ; ★ 把数据搬出 $INSTDIR —— 必须发生在模板删目录**之前**
  ; ---------------------------------------------------------------------------
  /*
   * ## 这里修的是一个会让「保留数据」变成假承诺的真 bug
   *
   * 我一开始把"不删数据"实现在 customUnInstall 里（判断用户选择，
   * 选保留就不 RMDir）。写完测试也绿了 —— 但那是**假绿**，因为
   * 本地 e2e 探针的删除顺序和真实模板不一致。
   *
   * 实测（scripts/_probe-uninst-rmdir.cjs）把真相挖出来了：
   *
   *   electron-builder 的 uninstaller.nsh 里，卸载段的顺序是
   *     :169   RMDir /r $INSTDIR          ← 无条件，先跑
   *     :239   !insertmacro customUnInstall  ← 后跑
   *
   *   实测输出：
   *     【A】模板真实顺序：RMDir /r $INSTDIR 在前
   *          卸载后 data\config.json 还在？ 没了
   *          customUnInstall 跑的时候 data 还活着？ 否
   *
   * 也就是说 customUnInstall 跑到时，**数据和安装目录一起早就没了**。
   * 而本产品的默认数据目录正是 $INSTDIR\data
   * （src/main/ipc.ts:3329 → join(process.execPath, '..', 'data')）。
   *
   * 后果：用户在卸载页选「保留用户数据」，数据照样被删 ——
   * 比没有这个选项更糟，因为它给了一个**假承诺**。
   *
   * ## 修法：把数据挪到模板够不着的地方
   *
   * customUnInit 跑在 un.onInit 里（uninstaller.nsh:26-28），
   * 那是**卸载段之前**、模板 RMDir 之前。趁这个空档把数据 Rename 出去：
   *
   *     $INSTDIR\data  →  $INSTDIR\..\AstriaX-uninst-keep\payload
   *
   * 同盘 Rename 只改目录项、瞬间完成，不搬内容。
   * 卸载跑完后再由 customUnInstall 把它放回原地（保留）或删掉（用户要删）。
   *
   * ## 既有的更新路径不受影响
   *
   * 更新时安装器带 --updated，那时**安装侧**的 customInit 已经先把数据
   * 挪到 $mxKeepDir 了（MXBOT_STASH_KEEP）。所以这里必须判 ${isUpdated}：
   * 更新时什么都不做，免得和安装侧抢数据。
   *
   * ## 只在"数据确实在 $INSTDIR 里面"时才动手
   *
   * 用户的 dataRoot 可能已经迁到别的盘（config:moveDataRoot）。
   * 那种情况下数据不在 $INSTDIR 下，模板的 RMDir /r $INSTDIR 碰不到它，
   * 这里也不需要搬。用 ${StrContains} 判断，避免把别处的数据搬进来。
   */
  Var /GLOBAL mxUnKeepDir
  Var /GLOBAL mxUnMoved
  /*
   * C-5（深度审查报告）：卸载时校验"注册表里的数据目录能否安全递归删除"。
   *
   *   · `mxDelOk`          这一次校验的状态位（"1" = 可以删）
   *   · `mxUnsafeDataRoot` 校验**没过**的路径（非空 = 卸载完要提示用户手工清理）
   *
   * 为什么用专用变量、而不是 `$R1/$R3` 那些寄存器：
   * 寄存器在这个脚本里被多处复用，拿它们存**跨好几条语句**的状态
   * 极易被中途覆盖 —— 那会表现为"校验结果莫名其妙不对"。
   * 而这是**删用户数据**的地方，容不下这种不确定性。
   */
  Var /GLOBAL mxDelOk
  Var /GLOBAL mxUnsafeDataRoot

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ 关闭正在运行的 AstriaX —— 用 electron-builder 的**官方扩展点**
   *   （主人 2026-09-27：「卸载程序永远无法关闭正在运行中的软件，导致卸载失败」）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 先说教训：不要自己写 taskkill 宏
   *
   * 我第一版在这里加了 `mxKillRunningApp`（tasklist + taskkill 三级兜底），
   * 结果**真实打包直接失败**：
   *     Error in macro mxKillRunningApp on macroline 6
   *     !include: error in script: "uninstaller.nsh" on line 27
   * 我一度以为是 `${StrContains}` 没 include（还专门补了 TextFunc.nsh）——
   * **猜错了**。真正原因是模板里**本来就有更完整的一套**，而且有扩展点：
   *
   *   uninstaller.nsh:1-3     Function un.checkAppRunning
   *                             !insertmacro CHECK_APP_RUNNING
   *   uninstaller.nsh:12,19   call un.checkAppRunning   ← 卸载开始就会调
   *   installSection.nsh:33   !insertmacro CHECK_APP_RUNNING
   *
   *   include/allowOnlyOneInstallerInstance.nsh:32
   *     !macro CHECK_APP_RUNNING
   *       !ifmacrodef customCheckAppRunning
   *         !insertmacro customCheckAppRunning    ← **官方扩展点**
   *       !else
   *         !insertmacro _CHECK_APP_RUNNING       ← 默认实现
   *       !endif
   *     !macroend
   *
   * 模板的默认实现（`_CHECK_APP_RUNNING`）比我的版本细：
   *   ① `taskkill /im`（温和）→ ② 轮询查 → ③ `taskkill /f /im`（强制）
   *   → ④ 再查、还在就 `Sleep 2000` 继续等；还区分 per-user/per-machine、
   *   并用 `/fi "PID ne $pid"` 排除自己。
   *
   * ## 我遇到的"关不掉"，缺陷其实在**我们的软件**这一侧
   *
   * 模板能杀掉进程。但我们的软件：
   *   · 点 ✕ 是"**缩回托盘**"（进程还在、文件还被占）
   *   · 覆盖更新时安装器用 `ExecWait '<旧卸载器> /S ...'`，
   *     `/S` 静默下模板的 `MessageBox ... /SD IDOK` 直接走杀进程分支 —— 通的
   *
   * 真正缺的是**温和退出**这一步：模板默认第一发 `taskkill /im` 不带 `/T`，
   * 而我们的实例进程（NapCat 注入的 QQ、AstrBot 的 python）是**子进程**，
   * 主进程被杀后它们会留下来继续占着文件 —— 紧接着的 `RMDir /r $INSTDIR`
   * 就会撞上"文件被占用"，这正是"卸载失败"的现场。
   *
   * ## 所以这里补的是：温和 → 等 → **连子进程树强制**
   *
   * 注意用了 `customCheckAppRunning` 之后，**模板的默认实现不会再跑**
   *（上面那个 if/else），所以强制的部分必须在这里自己补全 ——
   * 这是"用扩展点"的代价，也是它唯一的坑。
   */
  !macro customCheckAppRunning
    DetailPrint "AstriaX 正在运行，先请它正常退出…"

    /* ① 温和：请主进程自己走退出流程（killAll 停实例、endRun 清运行锁） */
    !ifdef INSTALL_MODE_PER_ALL_USERS
      nsExec::Exec 'taskkill /im "${APP_EXECUTABLE_FILENAME}"'
    !else
      nsExec::Exec '"$SYSDIR\cmd.exe" /c taskkill /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"'
    !endif
    Pop $R0

    /* ② 等最多 3 秒让它体面退出 */
    StrCpy $R1 0
    ${Do}
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${If} $R0 != 0
        ${ExitDo}
      ${EndIf}
      Sleep 600
      IntOp $R1 $R1 + 1
    ${LoopWhile} $R1 < 5

    /* ③ 还在 → 强制**连子进程树**（关键：带走实例与注入的 QQ） */
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      DetailPrint "AstriaX 没有响应退出请求，强制结束（含子进程）…"
      !ifdef INSTALL_MODE_PER_ALL_USERS
        nsExec::Exec 'taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}"'
      !else
        nsExec::Exec '"$SYSDIR\cmd.exe" /c taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"'
      !endif
      Pop $R0
      /* 给它一点时间真正释放文件句柄，否则紧接着的 RMDir 会撞"文件被占用" */
      Sleep 1200
    ${EndIf}
  !macroend

  !macro customUnInit
    StrCpy $mxUnMoved "0"
    StrCpy $mxUnKeepDir "$INSTDIR\..\AstriaX-uninst-keep"

    /* 更新时不做（安装侧已经在管数据了） */
    ${IfNot} ${isUpdated}
      /*
       * ══════════════════════════════════════════════════════════════════════
       * ★★ 抢救哪些数据目录：**安装目录下的 data 一定要抢救**
       *   （主人 2026-09-27 实测事故：「选择保留数据卸载，数据却残缺了」）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 事故现场
       *
       * 他选"保留数据"卸载，结果 `E:\MXBot\AstriaX\data` 里只剩两个残渣目录：
       *     data\cache\      （pip 缓存 —— 因为文件被占用才漏下来）
       *     data\runtimes\n\v4.18.19\  （只剩 native/ 几个 .node，缺 napcat.mjs
       *                                  与 NapCatWinBootMain.exe，是残缺运行时）
       * 而 `config.json` / `instances.json` / `instances\`（**实例数据**）/
       * `logs\` / `backups\` **全没了**。
       *
       * ## 根因：注册表指向别处时，安装目录下的 data 被当成垃圾删掉
       *
       * 原来的判断只有一条路：
       *     ReadRegStr $R0 HKCU "Software\MXBot" "DataRoot"
       *     ${If} $R0 == ""
       *       StrCpy $R0 "$INSTDIR\data"        ← 只有读不到注册表才看默认位置
       *     ${EndIf}
       *     前缀比对 → 相等才抢救
       *
       * 而他机器上的注册表是 `DataRoot = E:\MX\launcher-acb\data`
       *（之前调试/迁移留下的），于是：
       *   前缀比对 `E:\MX\launcher-acb\data` vs `E:\MXBot\AstriaX` → **不相等**
       *   → 判定"数据不在安装目录里" → **一个字节都不抢救**
       *   → 模板随后 `RMDir /r $INSTDIR`（这个不看我们的宏）
       *   → `$INSTDIR\data` 连同实例数据一起被删
       *
       * 换句话说：**卸载器盲目相信注册表，把安装目录下那份真实数据当垃圾了。**
       * 而注册表指向别处**并不排除**安装目录下也有一份数据 ——
       * 用户可能装过一次（数据落在默认位置）、后来又迁移过。
       *
       * ## 修法：两条路**各自独立**判断，谁在抢救谁
       *
       *   ① `$INSTDIR\data` 存在 → **无论如何都抢救**
       *      （它在卸载器的删除范围里，不抢救必被删）
       *   ② 注册表指向的目录**也在 $INSTDIR 之内** → 一并抢救
       *      （那种情况两台路径可能相同，用 origin.txt 记好搬回位置）
       *
       * "保留数据"是用户明确选的意图，**任何情况下都不能因为一个指针
       * 指歪了就把数据删掉** —— 宁可多重一份，不可少保一份。
       */
      StrCpy $R1 "0"

      /* ① 绝对优先：安装目录下的 data（不抢救就会被 RMDir 删掉） */
      ${If} ${FileExists} "$INSTDIR\data\*.*"
        ClearErrors
        CreateDirectory "$mxUnKeepDir"
        RMDir /r "$mxUnKeepDir\payload"
        Rename "$INSTDIR\data" "$mxUnKeepDir\payload"
        ${If} ${Errors}
          /*
           * 搬不动 = 数据被占用（实例还在跑 / 有句柄没释放）。
           *
           * 这时**必须中止卸载**：继续跑下去，模板的 RMDir 会把
           * 用户选了"保留"的数据删掉一半（能删的删、锁住的留），
           * 得到一个残缺目录 —— 那正是这次事故的样子。
           *
           * `/SD IDOK` 必须有：静默卸载时这个框照样会弹，没有 /SD 会永久挂住。
           */
          MessageBox MB_OK|MB_ICONSTOP \
            "无法保护数据目录：$INSTDIR\data$\n$\n它正被其他程序占用（多半是 AstriaX 或某个正在运行的实例）。$\n$\n请先完全退出 AstriaX、AstrBot、NapCat 和 QQ，再重新卸载。" \
            /SD IDOK
          Abort
        ${Else}
          StrCpy $mxUnMoved "1"
          /* 留个记号，customUnInstall 靠它知道数据搬到哪、该放回哪 */
          FileOpen $9 "$mxUnKeepDir\origin.txt" w
          FileWrite $9 "$INSTDIR\data"
          FileClose $9
        ${EndIf}
        StrCpy $R1 "1"
      ${EndIf}

      /* ② 注册表里记的数据目录：**仅当它也在 $INSTDIR 之内**时另行抢救 */
      ReadRegStr $R0 HKCU "Software\MXBot" "DataRoot"
      ${If} $R0 != ""
      ${AndIf} $R0 != "$INSTDIR\data"
        StrLen $R2 "$INSTDIR"
        StrCpy $R3 "$R0" $R2
        ${If} $R3 == "$INSTDIR"
        ${AndIf} ${FileExists} "$R0\*.*"
          /*
           * 数据在安装目录下的**别的子目录**（用户在设置里改过路径）。
           * 这种情况要单独搬 —— 它和 ① 是两份不同的数据，不能只保一份。
           *
           * 落脚点用 payload2：payload 已经被 ① 占用了。
           * origin2.txt 记它自己的原始路径（搬回时按各自的路径还原）。
           */
          ClearErrors
          CreateDirectory "$mxUnKeepDir"
          RMDir /r "$mxUnKeepDir\payload2"
          Rename "$R0" "$mxUnKeepDir\payload2"
          ${If} ${Errors}
            MessageBox MB_OK|MB_ICONSTOP \
              "无法保护数据目录：$R0$\n$\n它正被其他程序占用。请先完全退出 AstriaX、AstrBot、NapCat 和 QQ，再重新卸载。" \
              /SD IDOK
            Abort
          ${Else}
            FileOpen $9 "$mxUnKeepDir\origin2.txt" w
            FileWrite $9 "$R0"
            FileClose $9
          ${EndIf}
          StrCpy $R1 "1"
        ${EndIf}
      ${EndIf}

      ${If} $R1 == "1"
        StrCpy $mxUnMoved "1"
      ${EndIf}
    ${EndIf}
  !macroend
!endif

!macro customInit
  ; ---- 0) 回归初始化 ----
  ; 幂等宏需要它先为空，否则会用上一次运行（同一进程内不太可能，
  ; 但万一 customInit 被调用两次）留下的旧值。
  StrCpy $mxKeepDir ""
  StrCpy $mxRestoreFailed ""

  ; ---- 1) 先把上次中断留下的备份救回来（绝不能当垃圾删掉）----
  !insertmacro MXBOT_RESTORE_KEEP

  /*
   * ---- 1.5) 上一步恢复失败 → **立刻停手** ----
   *
   * 这是一处必须存在的闸门，原因是两条路径的"承诺"打架：
   *
   *   RESTORE 失败时弹框说："你的数据还在 $mxKeepDir\payload，
   *                          请手动复制到 $R8"
   *   而紧接着的 STASH 第一件事就是 `RMDir /r "$mxKeepDir"`。
   *
   * 也就是说，弹框刚承诺保留，下一行就把唯一副本删了。
   * 实测（scripts/_probe-fatal-claims.cjs）：
   *   AFTER_RESTORE=PRESENT   ← 确实留着
   *   AFTER_STASH=GONE        ← STASH 一跑就没了
   *
   * 更糟的是 STASH 删完还会把"当前残缺的 $INSTDIR\data"再搬成新 payload，
   * 于是用户按弹框提示去 keep 里找，看到的是一个**残缺的新备份**，
   * 而完整的那份已经没了 —— 比单纯报错危险得多。
   *
   * 所以：恢复失败就 Abort。不跑 STASH（不删备份），
   * 也不进入安装段（不会调旧卸载器，$INSTDIR 原样不动）。
   * 用户手工恢复完再重新运行安装包即可。
   */
  ${If} $mxRestoreFailed == "1"
    Abort
  ${EndIf}

  ; ---- 2) 阻止**降级**安装（主人实测：低版本居然能覆盖高版本）----------
  ;
  ; 原来只拦"完全相同"的版本，比当前**旧**的安装包照样能装 ——
  ; 用户拿旧的 0.1.1 去装一台已经装了 0.1.2 的机器，程序会被换成旧版，
  ; 而界面上完全没有任何提示（他甚至以为自己在"更新"）。
  ;
  ; 现在：已装版本 > 本包版本 → 明确中止并说清原因。
  ;
  ; 为什么要读注册表的 DisplayVersion 而不是看文件：
  ;   文件名/目录名都不携带版本，唯一可靠的"已装版本"就是安装登记项里的
  ;   DisplayVersion（electron-builder 安装时自动写，卸载时自动删）。
  ;
  ; ${VersionCompare} 的返回值（**WordFunc.nsh** 提供；上面已 include）：
  ;   0 = 相等   1 = 第一个参数大   2 = 第二个参数大
  ; 所以 `${VersionCompare} "${VERSION}" $R0 $R1` 后，$R1 == 2 即
  ; "已装的 $R0 比本包 ${VERSION} 大" = 降级。
  ;
  ; ── 踩坑记录：warning 6000 的真凶是**文案里把 $R0 写成 ${R0}** ────────
  ; 我一度以为是"传参要不要加引号"的问题，还写了段错误归因的注释。
  ; 用 `makensis -V4`（逐行输出）才定位到：警告发生在 **MessageBox 那一行**，
  ; 与 VersionCompare 无关 —— 文案里 `下载 ${R0}` 把运行时寄存器写成了
  ; `${...}` 形式（那是宏/define 的展开语法，寄存器只能写 `$R0`）。
  ; 另外用最小复现验证过：${VersionCompare} 收变量、加不加引号**都能过**
  ;（scripts/_probe-versioncompare.cjs），所以不要再去改那行的传参方式。
  ;
  ; 教训：NSIS 里 `$VAR` 与 `${VAR}` 是两种东西，文案里尤其容易手滑。
  ;
  ; /SD IDOK 必须有：静默安装（自动更新）时这个框也会弹，
  ; 没有 /SD 就永久挂住安装进程。给 IDOK = 静默时安静地中止。
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
  ${If} $R0 != ""
    ${VersionCompare} "${VERSION}" $R0 $R1
    ${If} $R1 == 2
      MessageBox MB_OK|MB_ICONSTOP "这台电脑上已经装了更新的版本（$R0）啦。$\n$\n本安装包是 ${VERSION}，比它旧，装上去会把新功能退回去，所以我不给你装哦。$\n$\n想装新版的话，请去下载 $R0 或更新的安装包~" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}

  ; ---- 2.1) 同版本拦截 ----
  ; 只拦**完全相同**的版本：比当前版本旧或新的安装包都继续走，
  ; 因为用户要求「任何低版本到任何更新的版本」都能覆盖安装。
  ;
  ; ── 为什么还要额外判一次「本产品的 exe 在不在」──────────────────────
  ;
  ; 光比版本号会误伤**改名后的第一版**。
  ;
  ; AstriaX 第一版沿用 0.1.0 这个版本号（主人指定「换风格和 logo 名字，
  ; 把这个当第一版成品」），而老 MXBot 的卸载登记项里 DisplayVersion
  ; 同样是 "0.1.0"。老的登记项要等旧版**被卸载**才消失 ——
  ; 如果用户只是手动删了文件夹、没走卸载，那条记录就还在。
  ; 此时只比版本号 → 判定"已安装过" → 弹个框然后 Quit，
  ; 用户**怎么点都装不上新版本**，而且提示词看起来完全合理，极难排查。
  ;
  ; 加一条「当前安装位置里确实有本产品的 exe」就分得清了：
  ;   MXBot 装在 E:\MXBot      → E:\MXBot\AstriaX.exe 不存在 → 放行，正常安装
  ;   AstriaX 装在 E:\AstriaX  → 里面就有 AstriaX.exe      → 拦住，避免重复安装
  ;
  ; 用 ${APP_EXECUTABLE_FILENAME}（= ${PRODUCT_FILENAME}.exe，见 common.nsh:16）
  ; 而不是写死文件名：以后改 exe 名这里会自动跟着走，不会脱节。
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
  ${If} $R0 == "${VERSION}"
  ${AndIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    /*
     * `/SD IDNO` 必须有，而且必须给 **IDNO**（不是 IDYES）。
     *
     * 静默安装时这个框照样弹；没有 /SD 就永久挂住。
     * 而如果给 IDYES，静默场景会**自动把程序打开** ——
     * 自动更新跑在后台，突然弹出主窗口是明显的错误行为。
     * 给 IDNO：静默时安静地 Quit，符合"静默安装"的预期。
     */
    MessageBox MB_YESNO|MB_ICONINFORMATION "AstriaX ${VERSION} 已经安装过，无需重复安装。$\n$\n要打开它吗？" /SD IDNO IDYES open IDNO done
    open:
      ExecShell "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      Quit
    done:
      Quit
  ${EndIf}

  ; ---- 2.5) 覆盖更新前，先把用户数据打包备份 ----
  /*
   * 放在 STASH **之前**：那时数据还安安静静躺在原位置，
   * 读取最稳、也不和随后的 Rename 抢文件。
   *
   * 放在"恢复失败就 Abort"那道闸门**之后**：
   * 恢复失败时一律停手，不该再做别的事。
   *
   * ------------------------------------------------------------------
   * 判据是「数据在不在」，**不是**「注册表里有没有安装记录」
   * ------------------------------------------------------------------
   *
   * 第一版写的是先 `ReadRegStr ... DisplayVersion`，有安装记录才备份。
   * 跑真机 e2e 时用例 7 直接红了，而它红得非常有价值 ——
   * 暴露的是一处**静默失效**：
   *
   *   只要那个卸载登记项因为任何原因不存在（用户清过注册表、
   *   appId 变过、上次卸载残留失败……），$R0 就是空串，
   *   于是备份**一声不响地被跳过**。用户以为"有自动备份"，
   *   真出事时才发现没有 —— 这比压根没有备份更危险。
   *
   * 而"要不要保护"这件事，判断依据本来就该是**数据在不在**：
   * 宏内部已经算出数据目录，为空时自己会跳过并打印说明
   * （首次安装没有旧数据，正属于这种情况）。
   * 所以这里无条件调用，由宏按数据存在与否自己决定 ——
   * 少一个外部依赖，就少一条静默失效的路径。
   */
  !insertmacro MXBOT_UPDATE_BACKUP

  ; ---- 3) 把数据保护起来，躲开旧卸载器的整目录删除 ----
  !insertmacro MXBOT_STASH_KEEP
!macroend

!macro customInstall
  ; 数据从落脚点搬回来
  !insertmacro MXBOT_RESTORE_KEEP

  ; --------------------------------------------------------------------------
  ; 通知外壳刷新图标缓存（指导书第四章：覆盖更新后图标/快捷方式要正常）
  ; --------------------------------------------------------------------------
  ;
  ; 覆盖更新会把 exe 换成新的：文件换了但 **Windows 图标缓存可能还是旧的**，
  ; 用户看到的现象是"更新完了图标还是老样子"（甚至空白图标），
  ; 从而怀疑"是不是根本没更新成功"。
  ;
  ; SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, 0, 0) 就是官方给的
  ; "告诉外壳：这些关联/图标变了，请重新读"的调用，不需要管理员也不需要
  ; 重建快捷方式 —— 关键是**不动快捷方式本身**：
  ;   · 桌面/开始菜单快捷方式的路径由 electron-builder 的模板创建，
  ;     覆盖更新时路径不变（同一个 $INSTDIR）→ Windows 记的图标位置
  ;     和任务栏固定项都还指向同一个目标，自然不会丢。
  ;   · 如果我们自己去删了重建，反而会把用户拖出来的图标位置重置掉。
  ; 所以这里只刷新缓存，绝不碰快捷方式。
  ;
  ; SHCNE_ASSOCCHANGED = 0x08000000（外壳级"关联变了"）
  ; SHCNF_IDLIST       = 0x0000
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

; ----------------------------------------------------------------------------
; 卸载
; ----------------------------------------------------------------------------
;
; 用户之前报告过：「卸载脚本遗漏了 E:\MXBot\data」—— 实测确认：
; 卸载后 E:\MXBot 里 MXBot.exe 没了，但 data\ 还在（27.29 MB）。
; 原因是这里原来只有 customInit / customInstall，没有 customUnInstall，
; electron-builder 默认只删自己写进去的文件，用户数据目录一律不碰。
;
; ## 怎么知道该删哪个目录
;
; 数据默认在 <安装目录>\data\，但用户可以在设置里改到别处
; （config.json 的 dataRoot，见 src/main/ipc.ts 的 config:moveDataRoot）。
; 所以不能写死 $INSTDIR\data。
;
; **故意不去解析 config.json**。NSIS 没有 JSON 解析，用 StrLoc/StrRep 抠字符串
; 又脆（引号、转义反斜杠、BOM、行尾都得出对）又得为卸载器单独声明一堆
; Un* 函数，稍有差池整个安装包就编译不过 —— 为了删个目录不值得冒这个险。
; 改成读**注册表**：程序每次保存配置时把 dataRoot 写进
; HKCU\Software\MXBot\DataRoot，卸载器读一个值就行，零解析风险。
;
; ## 判断「更新」还是「真卸载」
;
; 更新时安装器会先跑这个卸载器，并带 `--updated`（installUtil.nsh:206）。
; 不带这个参数才是用户在「控制面板 → 卸载程序」里真卸载。
; 不加这个判断的后果就是：用户点一次更新，数据被自己的卸载器删掉 ——
; 这正是本文件存在的最大理由。
;
; ## 真卸载时删不删，**由用户在卸载页上选**
;
; 主人要求：「卸载器加一个是否保留用户数据的选项，默认保留」。
;
; 所以这里的规则是（三重叠加，越靠前越优先）：
;
;   1. 更新（${isUpdated}）        → 一律不删，数据留给新版
;   2. 命令行 --delete-app-data    → 删（脚本化/静默卸载的显式要求）
;   3. 卸载页选了「一起删除」      → 删
;   4. 其余全部情况（含静默卸载）  → **保留**
;
; 第 4 条是关键：静默卸载（`/S`）根本不显示页面，$mxDataChoice 是空串。
; 旧代码在那种情况下是"无条件删"，现在变成"默认留"——
; 方向刚好相反，而这一条正是用户要的。
;
; ## 顺序上还有一层保险
;
; 哪怕这个判断因为某种原因失效了，customInit 也已经把数据挪到了
; $mxKeepDir（$INSTDIR 外面），customInstall 之后才放回来。
; 两道防线各自独立，任意一道生效都不会丢数据。

!macro customUnInstall
  Push $R1
  Push $R2

  /*
   * 用 electron-builder 注入的 `${isUpdated}` 判断，而不是自己解析命令行参数。
   *
   * 它的定义（见生成的 builder-debug.yml）是：
   *   !macro _isUpdated _a _b _t _f
   *     ${StdUtils.TestParameter} $R9 "updated"
   *     StrCmp "$R9" "true" `${_t}` `${_f}`
   *   !macroend
   * StdUtils.TestParameter 是插件实现的正规参数解析，`--updated` / `/updated`
   * 各种写法都认。而 `${GetOptions}` 只适合 `选项=值` 那种形式，
   * 拿来判裸 flag 会把后面的内容一起吞进结果里 —— 正是那种"看着能用、
   * 边界情况才坏"的写法。这种判断错一次的代价是用户数据全没，不该省这一步。
   */
  ${IfNot} ${isUpdated}
    /* ===== 真卸载：默认保留数据，只有用户明确要求才删 ===== */

    /* 先假定「保留」—— 默认安全的那一边 */
    StrCpy $R2 "0"

    /*
     * 命令行显式要求删除。
     *
     * 仍然用 StdUtils.TestParameter 而不是 ${GetOptions}，理由同上：
     * `--delete-app-data` 是个裸 flag，GetOptions 会把它后面的内容
     * 一起吞进结果。它对应 electron-builder 的 deleteAppDataOnUninstall，
     * 也是自动化测试用来明确表达"我就要删"的方式。
     */
    ${StdUtils.TestParameter} $R9 "delete-app-data"
    ${If} $R9 == "true"
      StrCpy $R2 "1"
    ${EndIf}

    /* 卸载页上用户选了「连同用户数据一起删除」 */
    ${If} $mxDataChoice == "2"
      StrCpy $R2 "1"
    ${EndIf}

    ${If} $R2 == "1"
      /* ---- 用户明确要求删除 ---- */

      /* 1) 注册表里记录的数据目录（用户改过路径时的真实位置） */
      ReadRegStr $R1 HKCU "Software\MXBot" "DataRoot"
      ${If} $R1 != ""
        /*
         * ══════════════════════════════════════════════════════════════════════
         * ★★ `RMDir /r` 之前必须做**形状校验**（审查报告 C-5，很危险的一条）
         * ══════════════════════════════════════════════════════════════════════
         *
         * ## 原来的问题
         *
         * 这里把注册表里的 `DataRoot` **原样**交给 `RMDir /r`，零校验。而：
         *
         *   · `HKCU\Software\MXBot\DataRoot` 是**当前用户可写**的普通值
         *     （不需要提权就能改）
         *   · 那个值来自**用户自己选的数据目录** —— 他完全可能选
         *     `D:\Bots`（里面还放着别的东西）甚至某个盘根
         *
         * 于是卸载时选「连同用户数据一起删除」，就会把那个目录
         * **整棵递归删掉** —— 包括里面不属于本程序的东西。这是
         * **不可逆的数据损失**，而且用户根本不会意识到。
         *
         * ## 三道最便宜的防线（都不依赖"用户看得仔细"）
         *
         * ① **必须是绝对路径**（`X:\...`）——排除相对路径/空值那种歧义
         * ② **不能是盘根**（长度 ≤ 4，如 `D:\`）——盘根递归删是灾难
         * ③ **必须长得像我们的数据目录** —— 里面有 `config.json`
         *    或 `instances`/`runtimes`/`logs` 之一
         *
         * ③ 是关键：它把"误删别人的目录"变成"只删我们自己的"。
         * 而只要用户用过本程序，数据目录里**必然**有这些（`config.json`
         * 是启动时就写的）。
         *
         * ## 校验不过怎么办
         *
         * **不删**，并把路径显示给用户让他手工清理 ——
         * 宁可留一点垃圾，也不能递归删掉用户的整个目录。
         *（下面 `$INSTDIR\data` 那份仍然照删：那是我们能确定归属的。）
         */
        StrCpy $mxDelOk "0"
        StrCpy $mxUnsafeDataRoot ""

        /* ① 绝对路径：第 2 个字符必须是 ':'，第 3 个是 '\' */
        StrCpy $R4 $R1 1 1
        ${If} $R4 == ":"
          StrCpy $R4 $R1 1 2
          ${If} $R4 == "\"
            StrCpy $mxDelOk "1"
          ${EndIf}
        ${EndIf}

        /* ② 不能是盘根：`D:\` 长度 3 —— 太短 */
        ${If} $mxDelOk == "1"
          StrLen $R4 $R1
          ${If} $R4 < 5
            StrCpy $mxDelOk "0"
          ${EndIf}
        ${EndIf}

        /* ③ 长得像我们的数据目录（否则一律不删） */
        ${If} $mxDelOk == "1"
          StrCpy $mxDelOk "0"
          ${If} ${FileExists} "$R1\config.json"
            StrCpy $mxDelOk "1"
          ${ElseIf} ${FileExists} "$R1\instances"
            StrCpy $mxDelOk "1"
          ${ElseIf} ${FileExists} "$R1\runtimes"
            StrCpy $mxDelOk "1"
          ${ElseIf} ${FileExists} "$R1\logs"
            StrCpy $mxDelOk "1"
          ${EndIf}
        ${EndIf}

        ${If} $mxDelOk == "1"
          RMDir /r "$R1"
        ${Else}
          /*
           * 校验不过：**只提示，不删**。
           * 记住它，卸载结束后单独弹一条（那时主窗口已关，弹框更醒目）。
           */
          StrCpy $mxUnsafeDataRoot "$R1"
        ${EndIf}
      ${EndIf}

      /* 2) 默认位置兜底（RMDir 对不存在目录不报错） */
      RMDir /r "$INSTDIR\data"

      /*
       * 2.5) customUnInit 抢救出来的那份。
       *
       * 数据默认在 $INSTDIR\data，而模板的 `RMDir /r $INSTDIR`
       * 在 customUnInstall **之前**就把它删了（实测见 _probe-uninst-rmdir.cjs）。
       * 所以 customUnInit 会把数据先挪到 $mxUnKeepDir\payload。
       * 用户选"一起删除"时，那份也要删 —— 否则"删干净"是假的。
       */
      ${If} $mxUnMoved == "1"
        RMDir /r "$mxUnKeepDir"
      ${EndIf}

      /*
       * 3) 备份落脚点（更新用的那个）。
       *
       * 选「删除」时一并清掉：数据都不要了，留个备份目录没意义。
       */
      !insertmacro MXBOT_SET_KEEP
      RMDir /r "$mxKeepDir"

      /* 4) 旧版遗留的临时备份目录（0.1.0 用的是这个路径） */
      RMDir /r "$TEMP\MX-launcher-data"

      /* 5) 清掉程序自己写的注册表项（数据都没了，指针也不用留） */
      DeleteRegKey HKCU "Software\MXBot"

      /*
       * 6) 有"校验没过所以没敢删"的数据目录吗？—— 如实告诉用户
       *
       * C-5：上面那段形状校验拦下了不像我们数据目录的路径。
       * 拦下之后**必须告诉用户**，否则他会以为"删干净了"，
       * 而那份目录其实还在（垃圾留着无害，但"以为删了其实没删"是误导）。
       *
       * 这里明确给出**完整路径**并请他手工处理 —— 我们不敢替他递归删，
       * 由他自己看一眼那个目录里有什么、决定怎么办，这是最安全的收尾。
       */
      ${If} $mxUnsafeDataRoot != ""
        /*
         * `/SD IDOK` 是**必须**的（自检会拦）：
         * 没有它，静默卸载（`/S`，自动更新走的就是这条）会**弹框并永久等待** ——
         * 没有人能点，于是自动更新整条链路卡死。
         *
         * 静默场景下用户看不到这个提示是**可接受的**：那只意味着
         * "有个不像数据目录的路径没被删"，下次他手工清理即可；
         * 而"更新卡死"是没法自救的。
         */
        MessageBox MB_OK|MB_ICONEXCLAMATION \
          "有一份数据目录**没有**被删除：$\r$\n$\r$\n    $mxUnsafeDataRoot$\r$\n$\r$\n\
          它看起来不像本程序的数据目录（里面没有 config.json / instances / runtimes / logs）。$\r$\n\
          为避免误删你自己的文件，安装程序**没有**动它。$\r$\n$\r$\n\
          如果你确认那是本程序的数据、且不再需要，请手工删除该目录。" \
          /SD IDOK
        StrCpy $mxUnsafeDataRoot ""
      ${EndIf}
    ${Else}
      /* ---- 保留数据（默认） ---- */

      /*
       * ★ 把 customUnInit 抢救出去的那份**搬回原位**。
       *
       * 这一步是"保留数据"能成立的关键 —— 不做它，数据虽然没被删，
       * 却留在 $INSTDIR\..\AstriaX-uninst-keep\payload 里，
       * 用户以为数据在 <安装目录>\data，实际找不到（等于丢了）。
       *
       * 搬回的目标从 origin.txt 读（customUnInit 写的原始路径），
       * 这样即使用户把数据放在 $INSTDIR 下的别的子目录也能放对地方。
       */
      ${If} $mxUnMoved == "1"
        StrCpy $R1 ""
        ${If} ${FileExists} "$mxUnKeepDir\origin.txt"
          FileOpen $9 "$mxUnKeepDir\origin.txt" r
          FileRead $9 $R1
          FileClose $9
        ${EndIf}
        ${If} $R1 == ""
          /* 读不到就退回默认位置，总比留在 keep 里强 */
          StrCpy $R1 "$INSTDIR\data"
        ${EndIf}

        ClearErrors
        CreateDirectory "$R1"
        /*
         * 先把目标清空再搬。
         * 模板的 RMDir 已经跑过，$INSTDIR 下的 data 通常不存在了；
         * 但用户的数据若在 $INSTDIR 之外的某个子目录里，
         * 目标可能还在（模板只删 $INSTDIR），清掉免得搬成嵌套。
         */
        RMDir /r "$R1"
        Rename "$mxUnKeepDir\payload" "$R1"
        ${If} ${Errors}
          /*
           * 搬不回去：数据**没有丢**，但在 keep 目录里。
           * 必须明确告诉用户它在哪 —— 否则他会以为数据没了。
           * 这时**故意不删** keep 目录。
           */
          MessageBox MB_OK|MB_ICONEXCLAMATION \
            "数据没能自动搬回原位，但它还在，没有丢：$\n$\n$mxUnKeepDir\payload$\n$\n请手动把它复制到：$R1" \
            /SD IDOK
        ${Else}
          /* 搬回成功 → 清掉空的落脚点，不留垃圾 */
          RMDir /r "$mxUnKeepDir"
          DetailPrint "用户数据已保留：$R1"
        ${EndIf}

        /*
         * ══════════════════════════════════════════════════════════════════
         * ★ 第二份数据（payload2）：注册表指向的那个"安装目录下的别处"
         * ══════════════════════════════════════════════════════════════════
         *
         * 为什么会有两份：customUnInit 现在**两条路各自独立判断** ——
         *   ① `$INSTDIR\data`（默认位置，不抢救就会被模板 RMDir 删掉）
         *   ② 注册表 DataRoot 指向的目录（用户在设置里改过路径，
         *      且它也在 $INSTDIR 之内）
         *
         * 这两份是**不同的数据**，得各搬各的、各放各的
         *（用 origin.txt / origin2.txt 分别记原始路径）。
         *
         * 单独的落脚点是 `payload2`，不能和 payload 混在一起 ——
         * 混了就会把两份数据搅成一坨，反而制造残缺。
         */
        ${If} ${FileExists} "$mxUnKeepDir\payload2\*.*"
          StrCpy $R2 ""
          ${If} ${FileExists} "$mxUnKeepDir\origin2.txt"
            FileOpen $9 "$mxUnKeepDir\origin2.txt" r
            FileRead $9 $R2
            FileClose $9
          ${EndIf}
          ${If} $R2 != ""
            ClearErrors
            CreateDirectory "$R2"
            RMDir /r "$R2"
            Rename "$mxUnKeepDir\payload2" "$R2"
            ${If} ${Errors}
              /* 同上：没丢，但在 keep 里，必须告诉用户它在哪 */
              MessageBox MB_OK|MB_ICONEXCLAMATION \
                "另一份数据没能自动搬回原位，但它还在，没有丢：$\n$\n$mxUnKeepDir\payload2$\n$\n请手动把它复制到：$R2" \
                /SD IDOK
            ${Else}
              DetailPrint "用户数据已保留：$R2"
            ${EndIf}
          ${EndIf}
        ${EndIf}

        /* 两份都搬完了才清落脚点；还有东西留下就保留（那是用户的唯一副本） */
        ${IfNot} ${FileExists} "$mxUnKeepDir\payload\*.*"
        ${AndIfNot} ${FileExists} "$mxUnKeepDir\payload2\*.*"
          RMDir /r "$mxUnKeepDir"
        ${EndIf}
      ${Else}
        /*
         * 没搬过 —— 数据要么不在 $INSTDIR 下（用户迁到别的盘了），
         * 要么本来就没有。两种情况都不需要动作。
         *
         * 保留注册表里的 DataRoot 指针：数据还在原地，留着它，
         * 将来重装或再次卸载时仍然找得到。
         */
        DetailPrint "已保留用户数据（未删除数据目录）"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  /* 更新时什么都不做 —— 数据要留给新版用 */

  Pop $R2
  Pop $R1
!macroend
