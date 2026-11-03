# Fontconfig WASM generator notices

This generated component uses the following libraries. FreeType is distributed under the FreeType License.

## Fontconfig 2.14.2

fontconfig/COPYING

Copyright © 2000,2001,2002,2003,2004,2006,2007 Keith Packard
Copyright © 2005 Patrick Lam
Copyright © 2007 Dwayne Bailey and Translate.org.za
Copyright © 2009 Roozbeh Pournader
Copyright © 2008,2009,2010,2011,2012,2013,2014,2015,2016,2017,2018,2019,2020 Red Hat, Inc.
Copyright © 2008 Danilo Šegan
Copyright © 2012 Google, Inc.


Permission to use, copy, modify, distribute, and sell this software and its
documentation for any purpose is hereby granted without fee, provided that
the above copyright notice appear in all copies and that both that
copyright notice and this permission notice appear in supporting
documentation, and that the name of the author(s) not be used in
advertising or publicity pertaining to distribution of the software without
specific, written prior permission.  The authors make no
representations about the suitability of this software for any purpose.  It
is provided "as is" without express or implied warranty.

THE AUTHOR(S) DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE,
INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS, IN NO
EVENT SHALL THE AUTHOR(S) BE LIABLE FOR ANY SPECIAL, INDIRECT OR
CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE,
DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.


--------------------------------------------------------------------------------
fontconfig/fc-case/CaseFolding.txt

© 2019 Unicode®, Inc.
Unicode and the Unicode Logo are registered trademarks of Unicode, Inc. in the U.S. and other countries.
For terms of use, see http://www.unicode.org/terms_of_use.html


--------------------------------------------------------------------------------
fontconfig/src/fcatomic.h

/*
 * Mutex operations.  Originally copied from HarfBuzz.
 *
 * Copyright © 2007  Chris Wilson
 * Copyright © 2009,2010  Red Hat, Inc.
 * Copyright © 2011,2012,2013  Google, Inc.
 *
 * Permission is hereby granted, without written agreement and without
 * license or royalty fees, to use, copy, modify, and distribute this
 * software and its documentation for any purpose, provided that the
 * above copyright notice and the following two paragraphs appear in
 * all copies of this software.
 *
 * IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE TO ANY PARTY FOR
 * DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES
 * ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS DOCUMENTATION, EVEN
 * IF THE COPYRIGHT HOLDER HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH
 * DAMAGE.
 *
 * THE COPYRIGHT HOLDER SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING,
 * BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS FOR A PARTICULAR PURPOSE.  THE SOFTWARE PROVIDED HEREUNDER IS
 * ON AN "AS IS" BASIS, AND THE COPYRIGHT HOLDER HAS NO OBLIGATION TO
 * PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.
 *
 * Contributor(s):
 *	Chris Wilson <chris@chris-wilson.co.uk>
 * Red Hat Author(s): Behdad Esfahbod
 * Google Author(s): Behdad Esfahbod
 */


--------------------------------------------------------------------------------
fontconfig/src/fcfoundry.h

/*
  Copyright © 2002-2003 by Juliusz Chroboczek

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
  THE SOFTWARE.
*/


--------------------------------------------------------------------------------
fontconfig/src/fcmd5.h

/*
 * This code implements the MD5 message-digest algorithm.
 * The algorithm is due to Ron Rivest.  This code was
 * written by Colin Plumb in 1993, no copyright is claimed.
 * This code is in the public domain; do with it what you wish.
 *
 * Equivalent code is available from RSA Data Security, Inc.
 * This code has been tested against that, and is equivalent,
 * except that you don't need to include two pages of legalese
 * with every copy.
 *
 * To compute the message digest of a chunk of bytes, declare an
 * MD5Context structure, pass it to MD5Init, call MD5Update as
 * needed on buffers full of bytes, and then call MD5Final, which
 * will fill a supplied 16-byte array with the digest.
 */


--------------------------------------------------------------------------------
fontconfig/src/fcmutex.h

/*
 * Atomic int and pointer operations.  Originally copied from HarfBuzz.
 *
 * Copyright © 2007  Chris Wilson
 * Copyright © 2009,2010  Red Hat, Inc.
 * Copyright © 2011,2012,2013  Google, Inc.
 *
 * Permission is hereby granted, without written agreement and without
 * license or royalty fees, to use, copy, modify, and distribute this
 * software and its documentation for any purpose, provided that the
 * above copyright notice and the following two paragraphs appear in
 * all copies of this software.
 *
 * IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE TO ANY PARTY FOR
 * DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES
 * ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS DOCUMENTATION, EVEN
 * IF THE COPYRIGHT HOLDER HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH
 * DAMAGE.
 *
 * THE COPYRIGHT HOLDER SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING,
 * BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS FOR A PARTICULAR PURPOSE.  THE SOFTWARE PROVIDED HEREUNDER IS
 * ON AN "AS IS" BASIS, AND THE COPYRIGHT HOLDER HAS NO OBLIGATION TO
 * PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.
 *
 * Contributor(s):
 *	Chris Wilson <chris@chris-wilson.co.uk>
 * Red Hat Author(s): Behdad Esfahbod
 * Google Author(s): Behdad Esfahbod
 */


--------------------------------------------------------------------------------
fontconfig/src/ftglue.[ch]

/* ftglue.c: Glue code for compiling the OpenType code from
 *           FreeType 1 using only the public API of FreeType 2
 *
 * By David Turner, The FreeType Project (www.freetype.org)
 *
 * This code is explicitely put in the public domain
 *
 * ==========================================================================
 *
 * the OpenType parser codes was originally written as an extension to
 * FreeType 1.x. As such, its source code was embedded within the library,
 * and used many internal FreeType functions to deal with memory and
 * stream i/o.
 *
 * When it was 'salvaged' for Pango and Qt, the code was "ported" to FreeType 2,
 * which basically means that some macro tricks were performed in order to
 * directly access FT2 _internal_ functions.
 *
 * these functions were never part of FT2 public API, and _did_ change between
 * various releases. This created chaos for many users: when they upgraded the
 * FreeType library on their system, they couldn't run Gnome anymore since
 * Pango refused to link.
 *
 * Very fortunately, it's possible to completely avoid this problem because
 * the FT_StreamRec and FT_MemoryRec structure types, which describe how
 * memory and stream implementations interface with the rest of the font
 * library, have always been part of the public API, and never changed.
 *
 * What we do thus is re-implement, within the OpenType parser, the few
 * functions that depend on them. This only adds one or two kilobytes of
 * code, and ensures that the parser can work with _any_ version
 * of FreeType installed on your system. How sweet... !
 *
 * Note that we assume that Pango doesn't use any other internal functions
 * from FreeType. It used to in old versions, but this should no longer
 * be the case. (crossing my fingers).
 *
 *  - David Turner
 *  - The FreeType Project  (www.freetype.org)
 *
 * PS: This "glue" code is explicitely put in the public domain
 */


## FreeType 2.13.0 (FreeType License)

                    The FreeType Project LICENSE
                    ----------------------------

                            2006-Jan-27

                    Copyright 1996-2002, 2006 by
          David Turner, Robert Wilhelm, and Werner Lemberg



Introduction
============

  The FreeType  Project is distributed in  several archive packages;
  some of them may contain, in addition to the FreeType font engine,
  various tools and  contributions which rely on, or  relate to, the
  FreeType Project.

  This  license applies  to all  files found  in such  packages, and
  which do not  fall under their own explicit  license.  The license
  affects  thus  the  FreeType   font  engine,  the  test  programs,
  documentation and makefiles, at the very least.

  This  license   was  inspired  by  the  BSD,   Artistic,  and  IJG
  (Independent JPEG  Group) licenses, which  all encourage inclusion
  and  use of  free  software in  commercial  and freeware  products
  alike.  As a consequence, its main points are that:

    o We don't promise that this software works. However, we will be
      interested in any kind of bug reports. (`as is' distribution)

    o You can  use this software for whatever you  want, in parts or
      full form, without having to pay us. (`royalty-free' usage)

    o You may not pretend that  you wrote this software.  If you use
      it, or  only parts of it,  in a program,  you must acknowledge
      somewhere  in  your  documentation  that  you  have  used  the
      FreeType code. (`credits')

  We  specifically  permit  and  encourage  the  inclusion  of  this
  software, with  or without modifications,  in commercial products.
  We  disclaim  all warranties  covering  The  FreeType Project  and
  assume no liability related to The FreeType Project.


  Finally,  many  people  asked  us  for  a  preferred  form  for  a
  credit/disclaimer to use in compliance with this license.  We thus
  encourage you to use the following text:

   """
    Portions of this software are copyright © <year> The FreeType
    Project (www.freetype.org).  All rights reserved.
   """

  Please replace <year> with the value from the FreeType version you
  actually use.


Legal Terms
===========

0. Definitions
--------------

  Throughout this license,  the terms `package', `FreeType Project',
  and  `FreeType  archive' refer  to  the  set  of files  originally
  distributed  by the  authors  (David Turner,  Robert Wilhelm,  and
  Werner Lemberg) as the `FreeType Project', be they named as alpha,
  beta or final release.

  `You' refers to  the licensee, or person using  the project, where
  `using' is a generic term including compiling the project's source
  code as  well as linking it  to form a  `program' or `executable'.
  This  program is  referred to  as  `a program  using the  FreeType
  engine'.

  This  license applies  to all  files distributed  in  the original
  FreeType  Project,   including  all  source   code,  binaries  and
  documentation,  unless  otherwise  stated   in  the  file  in  its
  original, unmodified form as  distributed in the original archive.
  If you are  unsure whether or not a particular  file is covered by
  this license, you must contact us to verify this.

  The FreeType  Project is copyright (C) 1996-2000  by David Turner,
  Robert Wilhelm, and Werner Lemberg.  All rights reserved except as
  specified below.

1. No Warranty
--------------

  THE FREETYPE PROJECT  IS PROVIDED `AS IS' WITHOUT  WARRANTY OF ANY
  KIND, EITHER  EXPRESS OR IMPLIED,  INCLUDING, BUT NOT  LIMITED TO,
  WARRANTIES  OF  MERCHANTABILITY   AND  FITNESS  FOR  A  PARTICULAR
  PURPOSE.  IN NO EVENT WILL ANY OF THE AUTHORS OR COPYRIGHT HOLDERS
  BE LIABLE  FOR ANY DAMAGES CAUSED  BY THE USE OR  THE INABILITY TO
  USE, OF THE FREETYPE PROJECT.

2. Redistribution
-----------------

  This  license  grants  a  worldwide, royalty-free,  perpetual  and
  irrevocable right  and license to use,  execute, perform, compile,
  display,  copy,   create  derivative  works   of,  distribute  and
  sublicense the  FreeType Project (in  both source and  object code
  forms)  and  derivative works  thereof  for  any  purpose; and  to
  authorize others  to exercise  some or all  of the  rights granted
  herein, subject to the following conditions:

    o Redistribution of  source code  must retain this  license file
      (`FTL.TXT') unaltered; any  additions, deletions or changes to
      the original  files must be clearly  indicated in accompanying
      documentation.   The  copyright   notices  of  the  unaltered,
      original  files must  be  preserved in  all  copies of  source
      files.

    o Redistribution in binary form must provide a  disclaimer  that
      states  that  the software is based in part of the work of the
      FreeType Team,  in  the  distribution  documentation.  We also
      encourage you to put an URL to the FreeType web page  in  your
      documentation, though this isn't mandatory.

  These conditions  apply to any  software derived from or  based on
  the FreeType Project,  not just the unmodified files.   If you use
  our work, you  must acknowledge us.  However, no  fee need be paid
  to us.

3. Advertising
--------------

  Neither the  FreeType authors and  contributors nor you  shall use
  the name of the  other for commercial, advertising, or promotional
  purposes without specific prior written permission.

  We suggest,  but do not require, that  you use one or  more of the
  following phrases to refer  to this software in your documentation
  or advertising  materials: `FreeType Project',  `FreeType Engine',
  `FreeType library', or `FreeType Distribution'.

  As  you have  not signed  this license,  you are  not  required to
  accept  it.   However,  as  the FreeType  Project  is  copyrighted
  material, only  this license, or  another one contracted  with the
  authors, grants you  the right to use, distribute,  and modify it.
  Therefore,  by  using,  distributing,  or modifying  the  FreeType
  Project, you indicate that you understand and accept all the terms
  of this license.

4. Contacts
-----------

  There are two mailing lists related to FreeType:

    o freetype@nongnu.org

      Discusses general use and applications of FreeType, as well as
      future and  wanted additions to the  library and distribution.
      If  you are looking  for support,  start in  this list  if you
      haven't found anything to help you in the documentation.

    o freetype-devel@nongnu.org

      Discusses bugs,  as well  as engine internals,  design issues,
      specific licenses, porting, etc.

  Our home page can be found at

    https://www.freetype.org


--- end of FTL.TXT ---


## libxml2 2.12.10

Except where otherwise noted in the source code (e.g. the files dict.c,
list.c and the trio files, which are covered by a similar licence but
with different Copyright notices) all the files are:

 Copyright (C) 1998-2012 Daniel Veillard.  All Rights Reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is fur-
nished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FIT-
NESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.


## Emscripten 3.1.65

Emscripten is available under 2 licenses, the MIT license and the
University of Illinois/NCSA Open Source License.

Both are permissive open source licenses, with little if any
practical difference between them.

The reason for offering both is that (1) the MIT license is
well-known, while (2) the University of Illinois/NCSA Open Source
License allows Emscripten's code to be integrated upstream into
LLVM, which uses that license, should the opportunity arise.

The full text of both licenses follows.

==============================================================================

Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

==============================================================================

Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.
All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal with the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

    Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimers.

    Redistributions in binary form must reproduce the above
    copyright notice, this list of conditions and the following disclaimers
    in the documentation and/or other materials provided with the
    distribution.

    Neither the names of Mozilla,
    nor the names of its contributors may be used to endorse
    or promote products derived from this Software without specific prior
    written permission. 

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE CONTRIBUTORS OR COPYRIGHT HOLDERS BE LIABLE FOR
ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE SOFTWARE.

==============================================================================

This program uses portions of Node.js source code located in src/library_path.js,
in accordance with the terms of the MIT license. Node's license follows:

    """
        Copyright Joyent, Inc. and other Node contributors. All rights reserved.
        Permission is hereby granted, free of charge, to any person obtaining a copy
        of this software and associated documentation files (the "Software"), to
        deal in the Software without restriction, including without limitation the
        rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
        sell copies of the Software, and to permit persons to whom the Software is
        furnished to do so, subject to the following conditions:

        The above copyright notice and this permission notice shall be included in
        all copies or substantial portions of the Software.

        THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
        IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
        FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
        AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
        LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
        FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
        IN THE SOFTWARE.
    """

The musl libc project is bundled in this repo, and it has the MIT license, see
system/lib/libc/musl/COPYRIGHT

The third_party/ subdirectory contains code with other licenses. None of it is
used by default, but certain options use it (e.g., the optional closure compiler
flag will run closure compiler from third_party/).



## musl

musl as a whole is licensed under the following standard MIT license:

----------------------------------------------------------------------
Copyright © 2005-2020 Rich Felker, et al.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
----------------------------------------------------------------------

Authors/contributors include:

A. Wilcox
Ada Worcester
Alex Dowad
Alex Suykov
Alexander Monakov
Andre McCurdy
Andrew Kelley
Anthony G. Basile
Aric Belsito
Arvid Picciani
Bartosz Brachaczek
Benjamin Peterson
Bobby Bingham
Boris Brezillon
Brent Cook
Chris Spiegel
Clément Vasseur
Daniel Micay
Daniel Sabogal
Daurnimator
David Carlier
David Edelsohn
Denys Vlasenko
Dmitry Ivanov
Dmitry V. Levin
Drew DeVault
Emil Renner Berthing
Fangrui Song
Felix Fietkau
Felix Janda
Gianluca Anzolin
Hauke Mehrtens
He X
Hiltjo Posthuma
Isaac Dunham
Jaydeep Patil
Jens Gustedt
Jeremy Huntwork
Jo-Philipp Wich
Joakim Sindholt
John Spencer
Julien Ramseier
Justin Cormack
Kaarle Ritvanen
Khem Raj
Kylie McClain
Leah Neukirchen
Luca Barbato
Luka Perkov
M Farkas-Dyck (Strake)
Mahesh Bodapati
Markus Wichmann
Masanori Ogino
Michael Clark
Michael Forney
Mikhail Kremnyov
Natanael Copa
Nicholas J. Kain
orc
Pascal Cuoq
Patrick Oppenlander
Petr Hosek
Petr Skocik
Pierre Carrier
Reini Urban
Rich Felker
Richard Pennington
Ryan Fairfax
Samuel Holland
Segev Finer
Shiz
sin
Solar Designer
Stefan Kristiansson
Stefan O'Rear
Szabolcs Nagy
Timo Teräs
Trutz Behn
Valentin Ochs
Will Dietz
William Haddon
William Pitcock

Portions of this software are derived from third-party works licensed
under terms compatible with the above MIT license:

The TRE regular expression implementation (src/regex/reg* and
src/regex/tre*) is Copyright © 2001-2008 Ville Laurikari and licensed
under a 2-clause BSD license (license text in the source files). The
included version has been heavily modified by Rich Felker in 2012, in
the interests of size, simplicity, and namespace cleanliness.

Much of the math library code (src/math/* and src/complex/*) is
Copyright © 1993,2004 Sun Microsystems or
Copyright © 2003-2011 David Schultz or
Copyright © 2003-2009 Steven G. Kargl or
Copyright © 2003-2009 Bruce D. Evans or
Copyright © 2008 Stephen L. Moshier or
Copyright © 2017-2018 Arm Limited
and labelled as such in comments in the individual source files. All
have been licensed under extremely permissive terms.

The ARM memcpy code (src/string/arm/memcpy.S) is Copyright © 2008
The Android Open Source Project and is licensed under a two-clause BSD
license. It was taken from Bionic libc, used on Android.

The AArch64 memcpy and memset code (src/string/aarch64/*) are
Copyright © 1999-2019, Arm Limited.

The implementation of DES for crypt (src/crypt/crypt_des.c) is
Copyright © 1994 David Burren. It is licensed under a BSD license.

The implementation of blowfish crypt (src/crypt/crypt_blowfish.c) was
originally written by Solar Designer and placed into the public
domain. The code also comes with a fallback permissive license for use
in jurisdictions that may not recognize the public domain.

The smoothsort implementation (src/stdlib/qsort.c) is Copyright © 2011
Valentin Ochs and is licensed under an MIT-style license.

The x86_64 port was written by Nicholas J. Kain and is licensed under
the standard MIT terms.

The mips and microblaze ports were originally written by Richard
Pennington for use in the ellcc project. The original code was adapted
by Rich Felker for build system and code conventions during upstream
integration. It is licensed under the standard MIT terms.

The mips64 port was contributed by Imagination Technologies and is
licensed under the standard MIT terms.

The powerpc port was also originally written by Richard Pennington,
and later supplemented and integrated by John Spencer. It is licensed
under the standard MIT terms.

All other files which have no copyright comments are original works
produced specifically for use as part of this library, written either
by Rich Felker, the main author of the library, or by one or more
contibutors listed above. Details on authorship of individual files
can be found in the git version control history of the project. The
omission of copyright and license comments in each file is in the
interest of source tree size.

In addition, permission is hereby granted for all public header files
(include/* and arch/*/bits/*) and crt files intended to be linked into
applications (crt/*, ldso/dlstart.c, and arch/*/crt_arch.h) to omit
the copyright notice and permission notice otherwise required by the
license, and to use these files without any requirement of
attribution. These files include substantial contributions from:

Bobby Bingham
John Spencer
Nicholas J. Kain
Rich Felker
Richard Pennington
Stefan Kristiansson
Szabolcs Nagy

all of whom have explicitly granted such permission.

This file previously contained text expressing a belief that most of
the files covered by the above exception were sufficiently trivial not
to be subject to copyright, resulting in confusion over whether it
negated the permissions granted in the license. In the spirit of
permissive licensing, and of not having licensing issues being an
obstacle to adoption, that text has been removed.


## zlib 1.2.13

ZLIB DATA COMPRESSION LIBRARY

zlib 1.2.13 is a general purpose data compression library.  All the code is
thread safe.  The data format used by the zlib library is described by RFCs
(Request for Comments) 1950 to 1952 in the files
http://tools.ietf.org/html/rfc1950 (zlib format), rfc1951 (deflate format) and
rfc1952 (gzip format).

All functions of the compression library are documented in the file zlib.h
(volunteer to write man pages welcome, contact zlib@gzip.org).  A usage example
of the library is given in the file test/example.c which also tests that
the library is working correctly.  Another example is given in the file
test/minigzip.c.  The compression library itself is composed of all source
files in the root directory.

To compile all files and run the test program, follow the instructions given at
the top of Makefile.in.  In short "./configure; make test", and if that goes
well, "make install" should work for most flavors of Unix.  For Windows, use
one of the special makefiles in win32/ or contrib/vstudio/ .  For VMS, use
make_vms.com.

Questions about zlib should be sent to <zlib@gzip.org>, or to Gilles Vollant
<info@winimage.com> for the Windows DLL version.  The zlib home page is
http://zlib.net/ .  Before reporting a problem, please check this site to
verify that you have the latest version of zlib; otherwise get the latest
version and check whether the problem still exists or not.

PLEASE read the zlib FAQ http://zlib.net/zlib_faq.html before asking for help.

Mark Nelson <markn@ieee.org> wrote an article about zlib for the Jan.  1997
issue of Dr.  Dobb's Journal; a copy of the article is available at
http://marknelson.us/1997/01/01/zlib-engine/ .

The changes made in version 1.2.13 are documented in the file ChangeLog.

Unsupported third party contributions are provided in directory contrib/ .

zlib is available in Java using the java.util.zip package, documented at
http://java.sun.com/developer/technicalArticles/Programming/compression/ .

A Perl interface to zlib written by Paul Marquess <pmqs@cpan.org> is available
at CPAN (Comprehensive Perl Archive Network) sites, including
http://search.cpan.org/~pmqs/IO-Compress-Zlib/ .

A Python interface to zlib written by A.M. Kuchling <amk@amk.ca> is
available in Python 1.5 and later versions, see
http://docs.python.org/library/zlib.html .

zlib is built into tcl: http://wiki.tcl.tk/4610 .

An experimental package to read and write files in .zip format, written on top
of zlib by Gilles Vollant <info@winimage.com>, is available in the
contrib/minizip directory of zlib.


Notes for some targets:

- For Windows DLL versions, please see win32/DLL_FAQ.txt

- For 64-bit Irix, deflate.c must be compiled without any optimization. With
  -O, one libpng test fails. The test works in 32 bit mode (with the -n32
  compiler flag). The compiler bug has been reported to SGI.

- zlib doesn't work with gcc 2.6.3 on a DEC 3000/300LX under OSF/1 2.1 it works
  when compiled with cc.

- On Digital Unix 4.0D (formely OSF/1) on AlphaServer, the cc option -std1 is
  necessary to get gzprintf working correctly. This is done by configure.

- zlib doesn't work on HP-UX 9.05 with some versions of /bin/cc. It works with
  other compilers. Use "make test" to check your compiler.

- gzdopen is not supported on RISCOS or BEOS.

- For PalmOs, see http://palmzlib.sourceforge.net/


Acknowledgments:

  The deflate format used by zlib was defined by Phil Katz.  The deflate and
  zlib specifications were written by L.  Peter Deutsch.  Thanks to all the
  people who reported problems and suggested various improvements in zlib; they
  are too numerous to cite here.

Copyright notice:

 (C) 1995-2022 Jean-loup Gailly and Mark Adler

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.

  Jean-loup Gailly        Mark Adler
  jloup@gzip.org          madler@alumni.caltech.edu

If you use the zlib library in a product, we would appreciate *not* receiving
lengthy legal documents to sign.  The sources are provided for free but without
warranty of any kind.  The library has been entirely written by Jean-loup
Gailly and Mark Adler; it does not include third-party code.  We make all
contributions to and distributions of this project solely in our personal
capacity, and are not conveying any rights to any intellectual property of
any third parties.

If you redistribute modified sources, we would appreciate that you include in
the file ChangeLog history information documenting your changes.  Please read
the FAQ for more information on the distribution of modified source versions.


