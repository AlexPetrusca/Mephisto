@echo off
rem Chrome on Windows will not execute a .py as a native-messaging host -- the manifest's "path" has
rem to be a .bat or an .exe. This shim is that, and nothing else.
rem
rem `py -3` is the Python launcher that ships with python.org installs and resolves a real
rem interpreter even when PATH does not; plain `python` is the fallback for a store/venv install.
rem %~dp0 is this file's own folder WITH a trailing backslash, so the host is found wherever the
rem installer put it. Quoted throughout: the runtime dir sits under a user profile, and user names
rem contain spaces far more often than not.
setlocal
py -3 "%~dp0tetrarch-host.py" %*
if errorlevel 9009 python "%~dp0tetrarch-host.py" %*
