# One tape for every README shot. The shot name comes in via $SHOT (the shell
# vhs drives expands it), so the frame always shows the REAL output of
# scripts/widget-shots.ts — never a hand-written line. `make shots` runs this
# once per shot, takes the last GIF frame with ffmpeg, crops it to the content
# and re-pads it. vhs drives a real terminal in a headless browser, so colour
# emoji render the way a user's terminal draws them (freeze could not do that).
Output "/tmp/hindsight-shot.gif"
Set FontSize 26
Set Width 1500
Set Height 800
Set Padding 24
Set Margin 0
Hide
Type "PS1=''"
Enter
Sleep 300ms
Type "clear; bun scripts/widget-shots.ts $SHOT; printf '\e[?25l'"
Enter
Sleep 1.5s
Show
Sleep 2s
